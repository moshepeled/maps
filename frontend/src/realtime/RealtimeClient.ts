/**
 * The WebSocket client of the `snapland.v1` protocol (SPEC section 7.2, section 7.11, section 7.12). Framework-free: time, randomness,
 * the ticket endpoint and the socket factory are injected, so the whole state machine runs under fake timers.
 *
 * States (the connection pill, UX C-16): connecting -> live -> reconnecting -> limited -> offline, plus signed-out.
 * - a fresh one-time ticket per attempt; full-jitter backoff; immediate retry on `online` / tab visible;
 * - liveness is judged on INBOUND traffic only: an app `ping` whenever nothing was received for 20 s (whatever the
 *   outbound traffic), close 4408 when nothing at all arrived for 45 s, and 4408 when `welcome` is late by 5 s;
 * - blips shorter than 3 s are invisible; after 10 s the app enters REST ("limited") mode and polls;
 * - 60 s anti-entropy pulls while live; `resync.required` and every reconnect trigger a feed pull (by the owner).
 */
import type { ClientMessage, ServerParseResult } from '@snapland/shared';
import { CLOSE_CODES, REALTIME, parseServerMessage } from '@snapland/shared';

import type { Scheduler } from '../lib/scheduler';
import { Timer } from '../lib/scheduler';
import { backoffDelayMs, closeCodeFloorMs, isReportableClose } from './backoff';

export type ConnectionState = 'connecting' | 'live' | 'reconnecting' | 'limited' | 'offline' | 'signed-out';

export type ServerMessageOf = Extract<ServerParseResult, { kind: 'message' }>['message'];
export type WelcomeData = Extract<ServerMessageOf, { type: 'welcome' }>['data'];
export type AckData = Extract<ServerMessageOf, { type: 'ack' }>['data'];
export type ErrorData = Extract<ServerMessageOf, { type: 'error' }>['data'];

/** The subset of the browser WebSocket the client uses (a fake in tests). */
export interface SocketLike {
  send(data: string): void;
  close(code?: number, reason?: string): void;
  onopen: (() => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
  onclose: ((event: { code: number; reason: string }) => void) | null;
  onerror: (() => void) | null;
}

export type TicketResult =
  { ok: true; ticket: string } | { ok: false; reason: 'session-ended' | 'network' | 'other' };

export type RequestResult =
  | { ok: true; data: AckData }
  | { ok: false; error: ErrorData }
  | { ok: false; error: { code: 'NOT_CONNECTED' | 'TIMEOUT'; message: string } };

export interface ClientErrorInput {
  kind: 'ws_close' | 'ws_schema';
  code?: number | string;
  message: string;
  context?: Record<string, string | number | boolean>;
}

export interface RealtimeHandlers {
  onState(state: ConnectionState, detail: { attempt: number; nextRetryAt: number | null }): void;
  /**
   * After every `welcome`. `isReconnect` is false only for the very first connection; `outageMs` is how long the live
   * channel was down (null on the first connection) - the owner shows "back online" after long outages (UX F-13).
   */
  onWelcome(welcome: WelcomeData, info: { isReconnect: boolean; outageMs: number | null }): void;
  /**
   * The welcomed socket is gone (closed, timed out, or `stop()`): everything this connection owned on the server (my
   * draft claim, soft locks) is lost until the next `welcome`. Not called for a browser `offline` event while the
   * socket itself stays open.
   */
  onChannelLost(): void;
  /** Every other parsed server message (batches are flattened; pongs and ref'd replies are consumed here). */
  onMessage(message: ServerMessageOf): void;
  onSignedOut(): void;
  /** Limited mode: pull the change feed (every 5 s). Resolves false when REST failed (-> offline). */
  onPollChanges(): Promise<boolean>;
  /** Limited mode: poll `GET /presence` (every 15 s). */
  onPollPresence(): Promise<void>;
  /** Live mode: the 60 s anti-entropy pull. */
  onAntiEntropy(): void;
  reportClientError(report: ClientErrorInput): void;
}

export interface RealtimeClientDeps {
  scheduler: Scheduler;
  random: () => number;
  fetchTicket(): Promise<TicketResult>;
  /** Refreshes the access token after a 4401 close; false when the session is over. */
  refreshSession(): Promise<boolean>;
  openSocket(ticket: string): SocketLike;
  isOnline(): boolean;
  handlers: RealtimeHandlers;
}

/** Consecutive REST failures (ticket fetches, polls) after which the app says "offline". */
export const OFFLINE_AFTER_REST_FAILURES = 3;
const REQUEST_TIMEOUT_MS = 10_000;
const SEND_QUEUE_MAX = 50;
/** `attempt` resets once a connection has stayed open this long (SPEC section 7.12 step 6). */
const ATTEMPT_RESET_AFTER_MS = 10_000;
/** Messages restated by the owner after every `welcome`, so queueing them would only replay stale state. */
const RESTATED_ON_WELCOME: ReadonlySet<ClientMessage['type']> = new Set([
  'viewport.set',
  'presence.update',
  'draft.start',
  'draft.update',
  'draft.touch',
  'draft.end',
  'ping',
]);

interface PendingRequest {
  resolve(result: RequestResult): void;
  timer: Timer;
}

type OutboundMessage = Omit<ClientMessage, 'ref'>;

export class RealtimeClient {
  private socket: SocketLike | null = null;
  private welcomed = false;
  private everConnected = false;
  private userStopped = true;
  private attempt = 0;
  private restFailures = 0;
  private state: ConnectionState = 'connecting';
  private nextRetryAt: number | null = null;
  private outageStartedAt: number | null = null;
  private refCounter = 0;
  private connectInFlight = false;
  private readonly pending = new Map<string, PendingRequest>();
  private queue: OutboundMessage[] = [];

  private readonly reconnectTimer: Timer;
  private readonly welcomeTimer: Timer;
  private readonly pingTimer: Timer;
  private readonly livenessTimer: Timer;
  private readonly graceTimer: Timer;
  private readonly degradeTimer: Timer;
  private readonly attemptResetTimer: Timer;
  private readonly antiEntropyTimer: Timer;
  private readonly pollChangesTimer: Timer;
  private readonly pollPresenceTimer: Timer;

  constructor(private readonly deps: RealtimeClientDeps) {
    const { scheduler } = deps;
    this.reconnectTimer = new Timer(scheduler, () => {
      void this.connect();
    });
    this.welcomeTimer = new Timer(scheduler, () => {
      this.closeSocket(CLOSE_CODES.HEARTBEAT_TIMEOUT, 'welcome timeout');
    });
    this.pingTimer = new Timer(scheduler, () => {
      this.sendRaw({ type: 'ping', data: { t: scheduler.now() } });
      this.pingTimer.arm(REALTIME.clientPingAfterInboundIdleMs);
    });
    this.livenessTimer = new Timer(scheduler, () => {
      this.closeSocket(CLOSE_CODES.HEARTBEAT_TIMEOUT, 'heartbeat timeout');
    });
    this.graceTimer = new Timer(scheduler, () => {
      if (this.state === 'live' || this.state === 'connecting') this.setState('reconnecting');
    });
    this.degradeTimer = new Timer(scheduler, () => {
      this.enterDegradedMode();
    });
    this.attemptResetTimer = new Timer(scheduler, () => {
      this.attempt = 0;
    });
    this.antiEntropyTimer = new Timer(scheduler, () => {
      if (this.welcomed) this.deps.handlers.onAntiEntropy();
      this.antiEntropyTimer.arm(REALTIME.antiEntropyIntervalMs);
    });
    this.pollChangesTimer = new Timer(scheduler, () => {
      void this.pollChanges();
    });
    this.pollPresenceTimer = new Timer(scheduler, () => {
      void this.pollPresence();
    });
  }

  get connectionState(): ConnectionState {
    return this.state;
  }

  get isLive(): boolean {
    return this.welcomed;
  }

  /** Starts (or restarts after sign-in) the connection loop. */
  start(): void {
    if (!this.userStopped) return;
    this.userStopped = false;
    this.attempt = 0;
    this.restFailures = 0;
    this.outageStartedAt = this.deps.scheduler.now();
    this.graceTimer.arm(REALTIME.wsGraceMs);
    this.degradeTimer.arm(REALTIME.wsDegradeAfterMs);
    this.setState('connecting');
    void this.connect();
  }

  /** User-initiated stop (sign-out, unload): close 1000 and do not reconnect. */
  stop(): void {
    this.userStopped = true;
    this.cancelAllTimers();
    const socket = this.socket;
    this.detachSocket();
    socket?.close(CLOSE_CODES.NORMAL, 'client stop');
    this.failPending('NOT_CONNECTED');
  }

  /**
   * The session ended while the socket was open: a REST refresh failed and the session dialog is up (UX F-11 step 2,
   * C-16). The live channel closes (1000) without reconnecting and the pill reads *Signed out*; signing in again
   * restarts it with `start()`.
   */
  endSession(): void {
    if (this.state === 'signed-out') return;
    const socket = this.socket;
    this.detachSocket();
    socket?.close(CLOSE_CODES.NORMAL, 'session ended');
    this.failPending('NOT_CONNECTED');
    this.signOut();
  }

  /** `online` / tab visible: retry now instead of waiting for the backoff (SPEC section 7.12 step 1). */
  retryNow(): void {
    if (this.userStopped || this.socket !== null) return;
    this.reconnectTimer.cancel();
    void this.connect();
  }

  handleOffline(): void {
    if (this.userStopped || this.state === 'signed-out') return;
    this.setState('offline');
  }

  handleOnline(): void {
    if (this.userStopped || this.state === 'signed-out') return;
    if (this.state === 'offline') this.setState(this.welcomed ? 'live' : 'reconnecting');
    this.retryNow();
  }

  /** Fire-and-forget message. Returns false when it could not be sent (and was not queued). */
  send(message: OutboundMessage): boolean {
    if (this.welcomed) {
      this.sendRaw(message);
      return true;
    }
    if (RESTATED_ON_WELCOME.has(message.type)) return false;
    this.queue.push(message);
    if (this.queue.length > SEND_QUEUE_MAX) this.queue.shift();
    return true;
  }

  /** A message with a `ref`, resolved by the matching `ack` / `error` (or NOT_CONNECTED / TIMEOUT). */
  request(message: OutboundMessage): Promise<RequestResult> {
    if (!this.welcomed) {
      return Promise.resolve({ ok: false, error: { code: 'NOT_CONNECTED', message: 'Not connected' } });
    }
    this.refCounter += 1;
    const ref = `c-${this.refCounter}`;
    return new Promise<RequestResult>((resolve) => {
      const timer = new Timer(this.deps.scheduler, () => {
        this.pending.delete(ref);
        resolve({ ok: false, error: { code: 'TIMEOUT', message: 'No reply' } });
      });
      timer.arm(REQUEST_TIMEOUT_MS);
      this.pending.set(ref, { resolve, timer });
      this.sendRaw({ ...message, ref });
    });
  }

  // -- connection loop -----------------------------------------------------------------------

  private async connect(): Promise<void> {
    if (this.userStopped || this.socket !== null || this.connectInFlight) return;
    this.nextRetryAt = null;
    this.connectInFlight = true;
    let ticket: TicketResult;
    try {
      ticket = await this.deps.fetchTicket();
    } finally {
      this.connectInFlight = false;
    }
    if (this.superseded()) return;
    if (!ticket.ok) {
      if (ticket.reason === 'session-ended') {
        this.signOut();
        return;
      }
      if (ticket.reason === 'network') this.noteRestFailure();
      this.scheduleReconnect(0);
      return;
    }
    this.noteRestSuccess();
    const socket = this.deps.openSocket(ticket.ticket);
    this.socket = socket;
    socket.onopen = () => {
      this.onInbound();
      this.welcomeTimer.arm(REALTIME.clientWelcomeTimeoutMs);
    };
    socket.onmessage = (event) => {
      this.onInbound();
      this.handleFrame(event.data);
    };
    socket.onclose = (event) => {
      if (this.socket !== socket) return;
      this.handleClose(event.code, event.reason);
    };
    socket.onerror = () => {
      // Errors are always followed by a close event, which drives the reconnect.
    };
  }

  private handleClose(code: number, reason: string): void {
    const wasWelcomed = this.welcomed;
    this.detachSocket();
    this.failPending('NOT_CONNECTED');
    if (this.userStopped) return;
    if (isReportableClose(code)) {
      this.deps.handlers.reportClientError({
        kind: 'ws_close',
        code,
        message: reason || `WebSocket closed with ${code}`,
      });
    }
    if (wasWelcomed) this.beginOutage();
    if (code === CLOSE_CODES.SESSION_REVOKED) {
      void this.recoverSession();
      return;
    }
    this.scheduleReconnect(closeCodeFloorMs(code));
  }

  private async recoverSession(): Promise<void> {
    const refreshed = await this.deps.refreshSession();
    if (this.userStopped) return;
    if (!refreshed) {
      this.signOut();
      return;
    }
    this.scheduleReconnect(0);
  }

  private signOut(): void {
    this.userStopped = true;
    this.cancelAllTimers();
    this.setState('signed-out');
    this.deps.handlers.onSignedOut();
  }

  private scheduleReconnect(floorMs: number): void {
    this.attempt += 1;
    const delay = Math.max(floorMs, backoffDelayMs(this.attempt, this.deps.random));
    this.nextRetryAt = this.deps.scheduler.now() + delay;
    this.reconnectTimer.arm(delay);
    this.emitState();
  }

  /** The connection was live and dropped: blips stay invisible for WS_GRACE_MS, REST mode starts after 10 s. */
  private beginOutage(): void {
    this.outageStartedAt = this.deps.scheduler.now();
    this.antiEntropyTimer.cancel();
    this.graceTimer.arm(REALTIME.wsGraceMs);
    this.degradeTimer.arm(REALTIME.wsDegradeAfterMs);
  }

  private enterDegradedMode(): void {
    if (this.welcomed || this.userStopped) return;
    const restFailing = this.restFailures >= OFFLINE_AFTER_REST_FAILURES;
    this.setState(this.deps.isOnline() && !restFailing ? 'limited' : 'offline');
    void this.pollChanges();
    void this.pollPresence();
  }

  private async pollChanges(): Promise<void> {
    if (this.welcomed || this.userStopped) return;
    const restWorks = await this.deps.handlers.onPollChanges();
    if (this.pollingObsolete()) return;
    if (restWorks) this.noteRestSuccess();
    else this.noteRestFailure();
    this.pollChangesTimer.arm(REALTIME.limitedPollChangesMs);
  }

  private async pollPresence(): Promise<void> {
    if (this.welcomed || this.userStopped) return;
    await this.deps.handlers.onPollPresence();
    if (this.pollingObsolete()) return;
    this.pollPresenceTimer.arm(REALTIME.limitedPollPresenceMs);
  }

  /** After an await: the client was stopped or another attempt already owns a socket. */
  private superseded(): boolean {
    return this.userStopped || this.socket !== null;
  }

  /** After an await: live again (or stopped), so the limited-mode poll loop ends. */
  private pollingObsolete(): boolean {
    return this.welcomed || this.userStopped;
  }

  private noteRestFailure(): void {
    this.restFailures += 1;
    if (this.restFailures >= OFFLINE_AFTER_REST_FAILURES && this.state !== 'signed-out')
      this.setState('offline');
  }

  private noteRestSuccess(): void {
    this.restFailures = 0;
    if (this.state === 'offline' && this.deps.isOnline()) {
      const degraded =
        this.outageStartedAt !== null &&
        this.deps.scheduler.now() - this.outageStartedAt >= REALTIME.wsDegradeAfterMs;
      this.setState(degraded ? 'limited' : 'reconnecting');
    }
  }

  // -- frames --------------------------------------------------------------------------------

  private onInbound(): void {
    this.pingTimer.arm(REALTIME.clientPingAfterInboundIdleMs);
    this.livenessTimer.arm(REALTIME.clientLivenessTimeoutMs);
  }

  private handleFrame(data: unknown): void {
    if (typeof data !== 'string') return;
    let value: unknown;
    try {
      value = JSON.parse(data);
    } catch {
      this.deps.handlers.reportClientError({ kind: 'ws_schema', message: 'Server frame is not JSON' });
      return;
    }
    this.dispatch(parseServerMessage(value));
  }

  private dispatch(result: ServerParseResult): void {
    switch (result.kind) {
      case 'batch':
        for (const inner of result.results) this.dispatch(inner);
        return;
      case 'unknown':
        return; // Forward compatibility: newer servers may add message types.
      case 'invalid':
        this.deps.handlers.reportClientError({
          kind: 'ws_schema',
          code: result.type ?? 'unknown',
          message: `Invalid server message ${result.type ?? ''}`.trim(),
          context: {
            issues: result.issues
              .map((issue) => `${issue.path}: ${issue.message}`)
              .join('; ')
              .slice(0, 400),
          },
        });
        return;
      case 'message':
        this.handleMessage(result.message);
    }
  }

  private handleMessage(message: ServerMessageOf): void {
    if (message.type === 'welcome') {
      this.onWelcome(message.data);
      return;
    }
    if (message.type === 'pong') return;
    const ref = message.ref;
    if ((message.type === 'ack' || message.type === 'error') && ref !== undefined) {
      const pending = this.pending.get(ref);
      if (pending !== undefined) {
        this.pending.delete(ref);
        pending.timer.cancel();
        pending.resolve(
          message.type === 'ack' ? { ok: true, data: message.data } : { ok: false, error: message.data },
        );
        return;
      }
    }
    this.deps.handlers.onMessage(message);
  }

  private onWelcome(welcome: WelcomeData): void {
    this.welcomeTimer.cancel();
    this.welcomed = true;
    const isReconnect = this.everConnected;
    this.everConnected = true;
    const outageMs =
      isReconnect && this.outageStartedAt !== null ? this.deps.scheduler.now() - this.outageStartedAt : null;
    this.outageStartedAt = null;
    this.nextRetryAt = null;
    this.restFailures = 0;
    this.graceTimer.cancel();
    this.degradeTimer.cancel();
    this.pollChangesTimer.cancel();
    this.pollPresenceTimer.cancel();
    this.attemptResetTimer.arm(ATTEMPT_RESET_AFTER_MS);
    this.antiEntropyTimer.arm(REALTIME.antiEntropyIntervalMs);
    this.setState('live');
    const queued = this.queue;
    this.queue = [];
    for (const message of queued) this.sendRaw(message);
    this.deps.handlers.onWelcome(welcome, { isReconnect, outageMs });
  }

  private sendRaw(message: OutboundMessage | ClientMessage): void {
    this.socket?.send(JSON.stringify(message));
  }

  private closeSocket(code: number, reason: string): void {
    const socket = this.socket;
    if (socket === null) return;
    socket.close(code, reason);
    // Browsers deliver the close event asynchronously; handle it now so a stuck socket cannot delay the reconnect.
    if (this.socket === socket) this.handleClose(code, reason);
  }

  /** Forgets the socket (closed by the server, the network, a timeout or `stop()`). */
  private detachSocket(): void {
    const socket = this.socket;
    const wasWelcomed = this.welcomed;
    if (socket !== null) {
      socket.onopen = null;
      socket.onmessage = null;
      socket.onclose = null;
      socket.onerror = null;
    }
    this.socket = null;
    this.welcomed = false;
    this.welcomeTimer.cancel();
    this.pingTimer.cancel();
    this.livenessTimer.cancel();
    this.attemptResetTimer.cancel();
    if (wasWelcomed) this.deps.handlers.onChannelLost();
  }

  private failPending(code: 'NOT_CONNECTED' | 'TIMEOUT'): void {
    for (const [ref, pending] of this.pending) {
      pending.timer.cancel();
      pending.resolve({ ok: false, error: { code, message: 'Connection closed' } });
      this.pending.delete(ref);
    }
  }

  private cancelAllTimers(): void {
    for (const timer of [
      this.reconnectTimer,
      this.welcomeTimer,
      this.pingTimer,
      this.livenessTimer,
      this.graceTimer,
      this.degradeTimer,
      this.attemptResetTimer,
      this.antiEntropyTimer,
      this.pollChangesTimer,
      this.pollPresenceTimer,
    ]) {
      timer.cancel();
    }
  }

  private setState(state: ConnectionState): void {
    if (this.state === state) {
      this.emitState();
      return;
    }
    this.state = state;
    this.emitState();
  }

  private emitState(): void {
    this.deps.handlers.onState(this.state, { attempt: this.attempt, nextRetryAt: this.nextRetryAt });
  }
}
