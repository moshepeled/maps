/**
 * Inbound frame handling (SPEC section 7.3, section 7.4, section 7.8). On arrival, synchronously: binary frames -> close 1003; JSON parse
 * (malformed -> MALFORMED_JSON); the per-connection token bucket (empty -> `draft.update`, `draft.touch`,
 * `presence.update`, `viewport.set` are dropped silently, every other type gets THROTTLED; more than 200 throttled
 * messages in 10 s -> close 4429); the STRICT shared client schemas (unknown type -> UNKNOWN_MESSAGE_TYPE, anything else
 * -> VALIDATION_FAILED; both invalid, > 20 in 60 s -> close 4400). Valid messages are then handled one at a time per
 * connection (serial queue, behind the handshake), so replies keep the order of the requests and `welcome` is always
 * the first message.
 */
import { CLIENT_MESSAGE_TYPES, CLOSE_CODES, parseClientMessage, peekEnvelope } from '@snapland/shared';
import type { ClientMessage, ClientMessageType, ProtocolIssue, WsErrorCode } from '@snapland/shared';
import type { RawData } from 'ws';

import type { Clock } from '../../infra/clock.js';
import type { Metrics } from '../../infra/metrics/metrics.js';
import type { Connection } from './connection.js';
import type { DraftService } from './drafts.js';
import { interestOf } from './interest.js';
import type { LockService } from './locks.js';
import { ackMessage, criticalMessage, errorMessage } from './messages.js';
import type { PresenceService } from './presence.js';

/** Types dropped silently when the bucket is empty: the client re-sends newer state anyway (section 7.8). */
const SILENTLY_THROTTLED: ReadonlySet<string> = new Set<ClientMessageType>([
  'draft.update',
  'draft.touch',
  'presence.update',
  'viewport.set',
]);

export interface InboundDispatcherDeps {
  drafts: DraftService;
  locks: LockService;
  presence: PresenceService;
  clock: Clock;
  metrics: Metrics;
}

/** Bounded metric label: a known client type, else `unknown`. */
function typeLabel(type: string | null): string {
  return type !== null && (CLIENT_MESSAGE_TYPES as readonly string[]).includes(type) ? type : 'unknown';
}

function frameText(data: RawData): string {
  if (Buffer.isBuffer(data)) return data.toString('utf8');
  if (Array.isArray(data)) return Buffer.concat(data).toString('utf8');
  return Buffer.from(data).toString('utf8');
}

export class InboundDispatcher {
  readonly #deps: InboundDispatcherDeps;

  constructor(deps: InboundDispatcherDeps) {
    this.#deps = deps;
  }

  /** The socket's `message` listener. */
  onFrame(connection: Connection, data: RawData, isBinary: boolean): void {
    connection.messagesIn += 1;
    if (isBinary) {
      this.#deps.metrics.wsMessagesDroppedTotal.inc({ type: 'binary', reason: 'invalid' });
      connection.close(CLOSE_CODES.UNSUPPORTED_DATA, 'binary frames are not supported');
      return;
    }
    if (!connection.isOpen) return;
    let value: unknown;
    try {
      value = JSON.parse(frameText(data));
    } catch {
      this.#invalid(connection, 'unknown', 'MALFORMED_JSON', 'The message is not valid JSON.', null);
      return;
    }
    const { type, ref } = peekEnvelope(value);
    if (!connection.bucket.tryTake(this.#deps.clock.now())) {
      this.#throttled(connection, type, ref);
      return;
    }
    const parsed = parseClientMessage(value);
    if (!parsed.ok) {
      const message =
        parsed.code === 'UNKNOWN_MESSAGE_TYPE'
          ? `Unknown message type ${String(parsed.type)}.`
          : 'The message does not match the snapland.v1 schema.';
      this.#invalid(connection, typeLabel(parsed.type), parsed.code, message, parsed.ref, parsed.issues);
      return;
    }
    const message = parsed.message;
    this.#deps.metrics.wsMessagesReceivedTotal.inc({ type: message.type });
    const queued = connection.inbound.push(() => this.#handleSafely(connection, message));
    if (!queued) this.#throttled(connection, message.type, message.ref ?? null);
  }

  async #handleSafely(connection: Connection, message: ClientMessage): Promise<void> {
    if (!connection.isOpen) return;
    const ref = message.ref ?? null;
    try {
      await this.#handle(connection, message, ref);
    } catch (error) {
      connection.log.error({ err: error, type: message.type }, 'WebSocket message handler failed');
      connection.send(errorMessage('INTERNAL_ERROR', 'An unexpected error occurred.', { ref }));
    }
  }

  async #handle(connection: Connection, message: ClientMessage, ref: string | null): Promise<void> {
    const { drafts, locks, presence } = this.#deps;
    switch (message.type) {
      case 'viewport.set': {
        const { bbox, zoom } = message.data;
        connection.viewport = { bbox, zoom };
        connection.interest = interestOf(bbox);
        connection.counts.viewportSets += 1;
        presence.changed(connection);
        this.#ack(connection, ref);
        return;
      }
      case 'presence.update':
        connection.reportedStatus = message.data.status;
        connection.counts.presenceUpdates += 1;
        presence.changed(connection);
        this.#ack(connection, ref);
        return;
      case 'draft.start':
        await drafts.start(connection, message.data, ref);
        return;
      case 'draft.update':
        drafts.update(connection, message.data, ref);
        return;
      case 'draft.touch':
        drafts.touch(connection, message.data, ref);
        return;
      case 'draft.end':
        await drafts.end(connection, message.data, ref);
        return;
      case 'lock.acquire':
        await locks.acquire(connection, message.data, ref);
        return;
      case 'lock.release':
        await locks.release(connection, message.data, ref);
        return;
      case 'ping':
        connection.counts.pings += 1;
        connection.send(
          criticalMessage('pong', { t: message.data.t, serverTime: this.#deps.clock.now() }, { ref }),
        );
        return;
    }
  }

  #ack(connection: Connection, ref: string | null): void {
    if (ref !== null) connection.send(ackMessage(ref));
  }

  #throttled(connection: Connection, type: string | null, ref: string | null): void {
    this.#deps.metrics.wsMessagesDroppedTotal.inc({ type: typeLabel(type), reason: 'throttled' });
    if (type === null || !SILENTLY_THROTTLED.has(type)) {
      connection.send(errorMessage('THROTTLED', 'Too many messages; slow down.', { ref }));
    }
    if (connection.floods.hit(this.#deps.clock.now())) {
      connection.close(CLOSE_CODES.FLOOD, 'message flood');
    }
  }

  #invalid(
    connection: Connection,
    label: string,
    code: WsErrorCode,
    message: string,
    ref: string | null,
    issues?: ProtocolIssue[],
  ): void {
    this.#deps.metrics.wsMessagesDroppedTotal.inc({ type: label, reason: 'invalid' });
    connection.send(
      errorMessage(code, message, { ref, ...(issues === undefined ? {} : { details: { issues } }) }),
    );
    if (connection.invalid.recordInvalid(this.#deps.clock.now())) {
      connection.close(CLOSE_CODES.INVALID_MESSAGES, 'too many invalid messages');
    }
  }
}
