/**
 * Cross-instance fan-out (SPEC section 7.10): turns bus events into server messages, serialised ONCE per instance, and
 * enqueues them on the interested local connections:
 *  - `areas`    -> `area.changed` (critical) to interest ∩ (new bbox ∪ previous bbox);
 *  - `drafts`   -> `draft.updated` (ephemeral `draft:<id>`) to interest ∩ draft bbox, never echoed to the sender;
 *                 `draft.ended` (critical, supersedes the pending update) to every connection with a viewport and
 *                 always to the owning connection;
 *  - `presence` -> `presence.joined|updated|left` (ephemeral `presence:<connectionId>`) to all connections
 *                 (`joined` not to its own subject, which learns about itself from `welcome`);
 *  - `locks`    -> `lock.changed` (ephemeral `lock:<areaId>`) to interest ∩ area bbox;
 *  - `sessions` -> the session's sockets are closed with 4401;
 *  - subscriber reconnect -> `resync.required` to every local connection AND an immediate session re-validation.
 */
import type { Clock } from '../../infra/clock.js';
import type {
  AreasBusPayload,
  DraftsBusPayload,
  LocksBusPayload,
  PresenceBusPayload,
  SessionsBusPayload,
} from '../../infra/events/payloads.js';
import type { BusChannel, BusEnvelope, EventBus } from '../../infra/events/types.js';
import type { Logger } from '../../infra/logger.js';
import type { Metrics } from '../../infra/metrics/metrics.js';
import type { ChangeSeqTracker } from './change-seq.js';
import type { Connection } from './connection.js';
import type { ConnectionRegistry } from './connection-registry.js';
import { intersectsInterest } from './interest.js';
import { criticalMessage, ephemeralKey, ephemeralMessage } from './messages.js';
import type { OutboundMessage } from './outbound-queue.js';

export interface FanoutDeps {
  events: EventBus;
  registry: ConnectionRegistry;
  changeSeq: ChangeSeqTracker;
  clock: Clock;
  metrics: Metrics;
  logger: Logger;
  /** Closes every local socket of a revoked session with 4401. */
  onSessionRevoked: (sessionId: string) => void;
  /** The bus subscriber reconnected: push resync.required and re-validate sessions now. */
  onBusReconnect: () => void;
}

export class Fanout {
  readonly #deps: FanoutDeps;
  #unsubscribe: (() => void)[] = [];

  constructor(deps: FanoutDeps) {
    this.#deps = deps;
  }

  start(): void {
    if (this.#unsubscribe.length > 0) return;
    const { events } = this.#deps;
    this.#unsubscribe = [
      events.subscribe('areas', (envelope) => {
        this.#observe('areas', envelope);
        this.#onArea(envelope.payload);
      }),
      events.subscribe('drafts', (envelope) => {
        this.#observe('drafts', envelope);
        this.#onDraft(envelope.payload);
      }),
      events.subscribe('presence', (envelope) => {
        this.#observe('presence', envelope);
        this.#onPresence(envelope.payload);
      }),
      events.subscribe('locks', (envelope) => {
        this.#observe('locks', envelope);
        this.#onLock(envelope.payload);
      }),
      events.subscribe('sessions', (envelope) => {
        this.#onSession(envelope.payload);
      }),
      events.onReconnect(() => {
        this.#deps.logger.warn('bus subscriber reconnected: resync.required + session re-validation');
        this.#deps.onBusReconnect();
      }),
    ];
  }

  stop(): void {
    for (const unsubscribe of this.#unsubscribe) unsubscribe();
    this.#unsubscribe = [];
  }

  #onArea(payload: AreasBusPayload): void {
    this.#deps.changeSeq.observe(payload.changeSeq);
    const message = criticalMessage('area.changed', {
      changeSeq: payload.changeSeq,
      op: payload.op,
      area: payload.area,
      changedFields: payload.changedFields,
      merged: payload.merged,
      previousName: payload.previousName,
      actor: payload.actor,
    });
    const targets = [payload.area.bbox, payload.prevBbox];
    this.#deliver(message, (connection) => intersectsInterest(connection.interest, targets));
  }

  #onDraft(payload: DraftsBusPayload): void {
    if (payload.kind === 'updated') {
      const message = ephemeralMessage(
        'draft.updated',
        {
          draftId: payload.draftId,
          user: payload.user,
          areaId: payload.areaId,
          rev: payload.rev,
          vertices: payload.vertices,
          cursor: payload.cursor,
        },
        ephemeralKey.draft(payload.draftId),
      );
      this.#deliver(
        message,
        (connection) =>
          connection.id !== payload.connectionId && intersectsInterest(connection.interest, [payload.bbox]),
      );
      return;
    }
    const message = criticalMessage(
      'draft.ended',
      { draftId: payload.draftId, userId: payload.user.id, outcome: payload.outcome, areaId: payload.areaId },
      { supersedes: ephemeralKey.draft(payload.draftId) },
    );
    this.#deliver(
      message,
      (connection) => connection.id === payload.connectionId || connection.interest !== null,
    );
  }

  #onPresence(payload: PresenceBusPayload): void {
    const key = ephemeralKey.presence(payload.connectionId);
    if (payload.kind === 'left') {
      const message = ephemeralMessage(
        'presence.left',
        { connectionId: payload.connectionId, userId: payload.userId },
        key,
      );
      this.#deliver(message, () => true);
      return;
    }
    if (payload.presence === undefined) return;
    const type = payload.kind === 'joined' ? 'presence.joined' : 'presence.updated';
    const message = ephemeralMessage(type, { presence: payload.presence }, key);
    this.#deliver(
      message,
      (connection) => payload.kind !== 'joined' || connection.id !== payload.connectionId,
    );
  }

  #onLock(payload: LocksBusPayload): void {
    const message = ephemeralMessage(
      'lock.changed',
      { areaId: payload.areaId, holder: payload.holder, scope: payload.scope, expiresAt: payload.expiresAt },
      ephemeralKey.lock(payload.areaId),
    );
    this.#deliver(message, (connection) => intersectsInterest(connection.interest, [payload.bbox]));
  }

  #onSession(payload: SessionsBusPayload): void {
    this.#deps.onSessionRevoked(payload.sessionId);
  }

  /** Linear scan of the local connections (section 7.8); the message string is shared by every recipient. */
  #deliver(message: OutboundMessage, wants: (connection: Connection) => boolean): void {
    for (const connection of this.#deps.registry.values()) {
      if (wants(connection)) connection.send(message);
    }
  }

  #observe(channel: BusChannel, envelope: BusEnvelope<unknown>): void {
    const latencyS = Math.max(0, this.#deps.clock.now() - envelope.ts) / 1000;
    this.#deps.metrics.wsFanoutLatency.observe({ channel }, latencyS);
  }
}
