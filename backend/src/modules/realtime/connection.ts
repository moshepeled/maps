/**
 * One WebSocket connection and its per-connection state (SPEC section 7): identity from the ticket claims, outbound queue,
 * inbound throttling and invalid-message accounting, interest region, reported presence status, the active draft and
 * the held locks. Components mutate the fields they own (drafts -> `draft`, locks -> `locks`, presence -> `presence*`);
 * nothing here performs I/O except handing frames to the socket.
 */
import { CLOSE_CODES } from '@snapland/shared';
import type { Bbox, Viewport } from '@snapland/shared';
import { WebSocket } from 'ws';

import type { AppConfig } from '../../config/env.js';
import type { WsTicketClaims } from '../../infra/auth/ws-tickets.js';
import type { Clock } from '../../infra/clock.js';
import type { Logger } from '../../infra/logger.js';
import type { Metrics } from '../../infra/metrics/metrics.js';
import { InvalidAccounting } from './invalid-accounting.js';
import { OutboundQueue } from './outbound-queue.js';
import type { OutboundMessage, SlowConsumerCause } from './outbound-queue.js';
import type { ReportedStatus } from './presence-status.js';
import { PROTOCOL_LIMITS } from './protocol-limits.js';
import { SerialTaskQueue } from './serial-queue.js';
import type { Cancel } from './timers.js';
import { TokenBucket, WindowCounter } from './token-bucket.js';
import type { ActiveDraft, ConnectionCounts, HeldLock } from './types.js';

export interface ConnectionDeps {
  config: Pick<
    AppConfig,
    | 'WS_OUTBOUND_MAX_MESSAGES'
    | 'WS_OUTBOUND_MAX_BYTES'
    | 'WS_SEND_HIGH_WATER_BYTES'
    | 'WS_SLOW_CONSUMER_TIMEOUT_MS'
    | 'REALTIME_DRAFT_RESUME_WINDOW_S'
  >;
  clock: Clock;
  metrics: Metrics;
  logger: Logger;
}

export interface ConnectionInit {
  id: string;
  socket: WebSocket;
  /** Who is connected (section 7.2): no profile lookup per connection. */
  identity: WsTicketClaims;
  ip: string | null;
  userAgent: string | null;
  /** Request id of the upgrade request (audit correlation). */
  requestId: string;
}

/** Close codes after which pending messages are discarded instead of flushed. */
const NO_FLUSH_ON_CLOSE: ReadonlySet<number> = new Set([
  CLOSE_CODES.SESSION_REVOKED,
  CLOSE_CODES.TRY_AGAIN_LATER,
]);

export class Connection {
  readonly id: string;
  readonly socket: WebSocket;
  readonly identity: WsTicketClaims;
  readonly ip: string | null;
  readonly userAgent: string | null;
  readonly requestId: string;
  readonly connectedAt: number;
  readonly log: Logger;

  readonly outbound: OutboundQueue;
  readonly bucket: TokenBucket;
  readonly floods: WindowCounter;
  readonly invalid: InvalidAccounting;
  /** The handshake, then every inbound handler, one at a time. */
  readonly inbound: SerialTaskQueue;
  readonly counts: ConnectionCounts = {
    viewportSets: 0,
    draftUpdates: 0,
    draftTouches: 0,
    presenceUpdates: 0,
    locks: 0,
    pings: 0,
  };

  /** Soft locks held by this connection (owned by the lock service). */
  readonly locks = new Map<string, HeldLock>();
  /** The active draft (owned by the draft service). */
  draft: ActiveDraft | null = null;

  viewport: Viewport | null = null;
  /** Viewport expanded by 50 % (section 7.8); null until the first `viewport.set`. */
  interest: Bbox | null = null;
  reportedStatus: ReportedStatus = 'viewing';
  /** Epoch ms of the last presence-relevant change (PresenceDto.updatedAt). */
  presenceUpdatedAt: number;
  /** True once the presence entry was registered in Redis and announced. */
  presenceRegistered = false;

  /** Heartbeat: false after a ping until the pong arrives. */
  alive = true;
  /** True once welcome + snapshots are queued. */
  ready = false;
  messagesIn = 0;
  messagesOut = 0;
  /** Cancels the absolute-expiry timer. */
  cancelExpiry: Cancel | null = null;

  /** Messages that arrived during the handshake (fan-out, error replies); queued right after welcome and the snapshots. */
  readonly #beforeReady: OutboundMessage[] = [];
  readonly #maxBeforeReady: number;
  #closing = false;
  #intendedCloseCode: number | null = null;

  constructor(init: ConnectionInit, deps: ConnectionDeps) {
    this.id = init.id;
    this.socket = init.socket;
    this.identity = init.identity;
    this.ip = init.ip;
    this.userAgent = init.userAgent;
    this.requestId = init.requestId;
    const now = deps.clock.now();
    this.connectedAt = now;
    this.presenceUpdatedAt = now;
    this.log = deps.logger.child({ connectionId: init.id, userId: init.identity.userId });

    const { config, metrics } = deps;
    this.bucket = new TokenBucket(
      { capacity: PROTOCOL_LIMITS.inboundBurst, refillPerSecond: PROTOCOL_LIMITS.inboundRefillPerSecond },
      now,
    );
    this.floods = new WindowCounter(PROTOCOL_LIMITS.floodDropLimit, PROTOCOL_LIMITS.floodWindowMs);
    this.invalid = new InvalidAccounting({
      limit: PROTOCOL_LIMITS.invalidLimit,
      windowMs: PROTOCOL_LIMITS.invalidWindowMs,
      ownedMemory: PROTOCOL_LIMITS.ownedDraftMemory,
      ownedTtlMs: config.REALTIME_DRAFT_RESUME_WINDOW_S * 1000,
    });
    this.inbound = new SerialTaskQueue(PROTOCOL_LIMITS.maxPendingInbound, (error) => {
      this.log.error({ err: error }, 'inbound handler failed');
    });
    this.#maxBeforeReady = config.WS_OUTBOUND_MAX_MESSAGES;
    this.outbound = new OutboundQueue({
      socket: init.socket,
      limits: {
        maxCriticalMessages: config.WS_OUTBOUND_MAX_MESSAGES,
        maxCriticalBytes: config.WS_OUTBOUND_MAX_BYTES,
        maxEphemeralKeys: PROTOCOL_LIMITS.maxEphemeralKeys,
        highWaterBytes: config.WS_SEND_HIGH_WATER_BYTES,
        slowConsumerTimeoutMs: config.WS_SLOW_CONSUMER_TIMEOUT_MS,
        maxFrameBytes: PROTOCOL_LIMITS.maxFrameBytes,
      },
      hooks: {
        onSent: (types, bytes) => {
          this.messagesOut += types.length;
          for (const type of types) metrics.wsMessagesSentTotal.inc({ type });
          metrics.wsSentBytesTotal.inc(bytes);
        },
        onDropped: (type, reason) => {
          metrics.wsMessagesDroppedTotal.inc({ type, reason });
        },
        onSlowConsumer: (cause: SlowConsumerCause) => {
          metrics.wsSlowConsumerDisconnectsTotal.inc();
          this.log.warn({ cause }, 'slow WebSocket consumer disconnected (1013)');
          this.close(CLOSE_CODES.TRY_AGAIN_LATER, 'slow consumer');
        },
      },
      clock: deps.clock,
    });
  }

  /** Open and not being closed by the server. */
  get isOpen(): boolean {
    return !this.#closing && this.socket.readyState === WebSocket.OPEN;
  }

  /** The close code the server chose, when it initiated the close. */
  get intendedCloseCode(): number | null {
    return this.#intendedCloseCode;
  }

  /** Queues a message; before `becomeReady` it is held back so that `welcome` is always the first message. */
  send(message: OutboundMessage): void {
    if (this.#closing) return;
    if (this.ready) {
      this.outbound.enqueue(message);
      return;
    }
    if (this.#beforeReady.length >= this.#maxBeforeReady) {
      this.close(CLOSE_CODES.TRY_AGAIN_LATER, 'too many events during the handshake');
      return;
    }
    this.#beforeReady.push(message);
  }

  /** Queues the handshake messages (welcome, snapshots), then everything held back, and opens the connection. */
  becomeReady(initial: readonly OutboundMessage[]): void {
    if (this.#closing) return;
    for (const message of initial) this.outbound.enqueue(message);
    for (const message of this.#beforeReady.splice(0)) this.outbound.enqueue(message);
    this.ready = true;
  }

  /**
   * Closes the socket with `code` (idempotent: the first code wins). Pending messages are flushed first when the socket
   * can take them, so the client receives e.g. the error replies that led to a 4400, except after a revocation (no
   * more data for a revoked session) and for a slow consumer (its socket cannot take more).
   */
  close(code: number, reason: string): void {
    if (this.#closing) return;
    this.#closing = true;
    this.#intendedCloseCode = code;
    if (!NO_FLUSH_ON_CLOSE.has(code)) this.outbound.flush();
    this.outbound.close();
    if (this.socket.readyState === WebSocket.OPEN || this.socket.readyState === WebSocket.CONNECTING) {
      this.socket.close(code, reason);
    }
  }

  /** Drops the socket without a close frame (heartbeat timeout, section 7.11). */
  terminate(): void {
    if (!this.#closing) {
      this.#closing = true;
      this.#intendedCloseCode = CLOSE_CODES.ABNORMAL;
      this.outbound.close();
    }
    this.socket.terminate();
  }

  /** Marks the connection closed from the socket's side (close event). */
  markClosed(): void {
    this.#closing = true;
    this.outbound.close();
  }
}
