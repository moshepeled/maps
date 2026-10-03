/**
 * Live drafts (SPEC section 7.6 v1.2 lifecycle table). A connection has at most one active draft; its local state is
 * authoritative for update/touch, the Redis registry (`container.drafts`) proves ownership across instances:
 *  - `draft.start {resume:false}`: 1 drawing action consumed FIRST (rejected -> RATE_LIMITED, nothing claimed), then
 *    `claim` (SET NX); an existing record -> DRAFT_ID_IN_USE; claimed -> ack {drawActionsRemaining}, rev-0 announcement;
 *  - `draft.start {resume:true}`: free; same user and (same session or a `disconnected` record) -> resumed; else
 *    DRAFT_NOT_FOUND;
 *  - `draft.update` / `draft.touch`: only for the active draft; both reset the idle timer and touch the registry;
 *    updates are re-quantised to 6 dp, stale revs dropped, coalesced and relayed; touches are never relayed;
 *  - end, implicit cancel (a new start) and idle expiry (REALTIME_DRAFT_IDLE_MS without update/touch): the coalescer and
 *    keyframe timer are cancelled FIRST (a pending update is discarded), then `release`, then `draft.ended` - delivered
 *    to viewers and to the owner;
 *  - socket close: cancel, then `markDisconnected`; `draft.ended 'disconnected'` only when this connection still owned
 *    the record (a takeover by a resume on another instance publishes nothing).
 * Redis down: claim/resume fail -> the start is accepted with local ownership only (section 7.6 availability trade-off).
 * DRAFT_NOT_FOUND counts as invalid only for ids this connection never owned (invalid-accounting.ts).
 */
import { CLOSE_CODES, DRAFT_DECIMALS, bboxOfPositions, quantizePosition } from '@snapland/shared';
import type { ClientMessageOf, Position } from '@snapland/shared';

import type { AppConfig } from '../../config/env.js';
import type { Clock } from '../../infra/clock.js';
import type { DraftRegistry } from '../../infra/drafts/types.js';
import type { EventBus } from '../../infra/events/types.js';
import { runDetached } from '../../infra/lifecycle.js';
import type { Logger } from '../../infra/logger.js';
import type { Metrics } from '../../infra/metrics/metrics.js';
import type { DrawRateLimiter } from '../../infra/ratelimit/types.js';
import type { Connection } from './connection.js';
import { DraftCoalescer } from './draft-coalescer.js';
import { ackMessage, errorMessage } from './messages.js';
import type { ServerData } from './messages.js';
import type { RealtimeAudit } from './realtime-audit.js';
import { unrefTimeout } from './timers.js';
import type { ActiveDraft, DraftFrame } from './types.js';

type DraftStartData = ClientMessageOf<'draft.start'>['data'];
type DraftUpdateData = ClientMessageOf<'draft.update'>['data'];
type DraftTouchData = ClientMessageOf<'draft.touch'>['data'];
type DraftEndData = ClientMessageOf<'draft.end'>['data'];
type DraftEndOutcome = 'committed' | 'cancelled' | 'expired' | 'disconnected';

export interface DraftServiceDeps {
  registry: DraftRegistry;
  limiter: DrawRateLimiter;
  events: EventBus;
  clock: Clock;
  logger: Logger;
  metrics: Metrics;
  config: Pick<
    AppConfig,
    | 'REALTIME_DRAFT_IDLE_MS'
    | 'REALTIME_DRAFT_KEYFRAME_MS'
    | 'REALTIME_DRAFT_COALESCE_MS'
    | 'DRAW_RATE_LIMIT_WINDOW_MS'
  >;
  audit: RealtimeAudit;
  instanceId: string;
  /** The connection's derived presence status may have changed (draft started or ended). */
  onStatusChanged: (connection: Connection) => void;
}

/** How a draft becomes active: a fresh claim (announced with rev 0) or a resume (free, nothing announced). */
interface Activation {
  localOnly: boolean;
  resume: boolean;
  ref: string | null;
  ackData: ServerData<'ack'>;
}

export class DraftService {
  readonly #deps: DraftServiceDeps;
  readonly #log: Logger;

  constructor(deps: DraftServiceDeps) {
    this.#deps = deps;
    this.#log = deps.logger.child({ component: 'drafts' });
  }

  async start(connection: Connection, data: DraftStartData, ref: string | null): Promise<void> {
    if (data.resume) await this.#resume(connection, data, ref);
    else await this.#startNew(connection, data, ref);
  }

  update(connection: Connection, data: DraftUpdateData, ref: string | null): void {
    connection.counts.draftUpdates += 1;
    const draft = connection.draft;
    if (draft?.draftId !== data.draftId) {
      this.#notFound(connection, data.draftId, ref, 'draft.update');
      return;
    }
    if (data.rev <= draft.lastRev) {
      // Stale or duplicated state: a newer one was already accepted.
      this.#deps.metrics.wsMessagesDroppedTotal.inc({ type: 'draft.update', reason: 'coalesced' });
      if (ref !== null) connection.send(ackMessage(ref));
      return;
    }
    draft.lastRev = data.rev;
    this.#keepAlive(connection, draft);
    draft.coalescer.push(toFrame(data));
    if (ref !== null) connection.send(ackMessage(ref));
  }

  touch(connection: Connection, data: DraftTouchData, ref: string | null): void {
    connection.counts.draftTouches += 1;
    const draft = connection.draft;
    if (draft?.draftId !== data.draftId) {
      this.#notFound(connection, data.draftId, ref, 'draft.touch');
      return;
    }
    // Keepalive only: never relayed (section 7.4), it just proves the owner is still there.
    this.#keepAlive(connection, draft);
    if (ref !== null) connection.send(ackMessage(ref));
  }

  async end(connection: Connection, data: DraftEndData, ref: string | null): Promise<void> {
    const draft = connection.draft;
    if (draft?.draftId !== data.draftId) {
      this.#deps.audit.denied('draft.end', 'DRAFT_NOT_FOUND', connection, data.draftId);
      this.#notFound(connection, data.draftId, ref, 'draft.end');
      return;
    }
    await this.#finish(connection, draft, data.outcome, data.areaId ?? draft.areaId);
    if (ref !== null) connection.send(ackMessage(ref));
  }

  /** Socket closed: cancel timers, then markDisconnected (the draft stays resumable for the resume window). */
  async disconnect(connection: Connection): Promise<void> {
    const draft = connection.draft;
    if (draft === null) return;
    this.#stopTimers(draft);
    connection.draft = null;
    const owned = await this.#stillOwns(draft, connection, () =>
      this.#deps.registry.markDisconnected(draft.draftId, connection.id),
    );
    if (!owned) {
      this.#log.info({ draftId: draft.draftId }, 'draft was taken over by a resume; nothing published');
      return;
    }
    await this.#publishEnded(connection, draft, 'disconnected', draft.areaId);
    this.#deps.audit.draftEnded(connection, draft.draftId, draft.areaId, 'disconnected');
  }

  async #startNew(connection: Connection, data: DraftStartData, ref: string | null): Promise<void> {
    const { draftId, areaId } = data;
    // The drawing action is consumed strictly before the claim: a refused start claims nothing.
    const decision = await this.#deps.limiter.consume(connection.identity.userId, 'draft.start');
    if (!decision.allowed) {
      this.#deps.metrics.rateLimitRejectionsTotal.inc({ scope: 'draw', transport: 'ws' });
      this.#deps.audit.drawRateLimitHit(connection, decision.limit);
      this.#deps.audit.denied('draft.start', 'RATE_LIMITED', connection, draftId, { resume: false });
      const windowS = Math.round(this.#deps.config.DRAW_RATE_LIMIT_WINDOW_MS / 1000);
      connection.send(
        errorMessage('RATE_LIMITED', `Drawing action limit reached (${decision.limit} per ${windowS} s).`, {
          ref,
          retryAfterMs: decision.retryAfterMs,
        }),
      );
      return;
    }
    const claim = await this.#registryOrLocal(draftId, () =>
      this.#deps.registry.claim(draftId, this.#owner(connection)),
    );
    if (claim === 'in_use') {
      this.#deps.audit.denied('draft.start', 'DRAFT_ID_IN_USE', connection, draftId, { resume: false });
      connection.send(errorMessage('DRAFT_ID_IN_USE', `Draft id ${draftId} is already in use.`, { ref }));
      return;
    }
    await this.#activate(connection, draftId, areaId, {
      localOnly: claim === 'local',
      resume: false,
      ref,
      ackData: { drawActionsRemaining: decision.remaining },
    });
  }

  async #resume(connection: Connection, data: DraftStartData, ref: string | null): Promise<void> {
    const { draftId, areaId } = data;
    if (connection.draft?.draftId === draftId) {
      // Already active on this connection (a repeated resume): nothing to take over.
      if (ref !== null) connection.send(ackMessage(ref));
      return;
    }
    const result = await this.#registryOrLocal(draftId, () =>
      this.#deps.registry.resume(draftId, this.#owner(connection)),
    );
    if (result === 'not_found') {
      this.#deps.audit.denied('draft.start', 'DRAFT_NOT_FOUND', connection, draftId, { resume: true });
      this.#notFound(connection, draftId, ref, 'draft.start');
      return;
    }
    // Free: no drawing action was consumed, so the ack carries no remaining budget.
    await this.#activate(connection, draftId, areaId, {
      localOnly: result === 'local',
      resume: true,
      ref,
      ackData: {},
    });
  }

  /** A registry write while Redis is unreachable: the draft is accepted with local ownership only (section 7.6). */
  async #registryOrLocal<T>(draftId: string, op: () => Promise<T>): Promise<T | 'local'> {
    try {
      return await op();
    } catch (error) {
      this.#log.warn(
        { err: error, draftId },
        'draft registry unavailable; accepting the draft with local ownership',
      );
      return 'local';
    }
  }

  /** Ends the previous draft (implicit cancel, section 7.4), activates the new one, acks it and announces it. */
  async #activate(
    connection: Connection,
    draftId: string,
    areaId: string | null,
    activation: Activation,
  ): Promise<void> {
    const previous = connection.draft;
    if (previous !== null) await this.#finish(connection, previous, 'cancelled', previous.areaId);
    const { config } = this.#deps;
    const coalescer = new DraftCoalescer<DraftFrame>({
      coalesceMs: config.REALTIME_DRAFT_COALESCE_MS,
      keyframeMs: config.REALTIME_DRAFT_KEYFRAME_MS,
      publish: (frame) => {
        runDetached(this.#publishUpdated(connection, draftId, areaId, frame), this.#log, 'draft.updated');
      },
    });
    const draft: ActiveDraft = {
      draftId,
      areaId,
      lastRev: 0,
      coalescer,
      cancelIdle: null,
      localOnly: activation.localOnly,
    };
    connection.draft = draft;
    connection.invalid.rememberOwned(draftId, this.#deps.clock.now());
    this.#armIdle(connection, draft);
    if (activation.ref !== null) connection.send(ackMessage(activation.ref, activation.ackData));
    if (!activation.resume) coalescer.publishNow({ rev: 0, vertices: [], cursor: null, bbox: null });
    this.#deps.audit.draftStarted(connection, draftId, areaId, activation.resume);
    this.#deps.onStatusChanged(connection);
  }

  /** end / implicit cancel / idle expiry: cancel timers -> release -> draft.ended (to viewers and the owner). */
  async #finish(
    connection: Connection,
    draft: ActiveDraft,
    outcome: Exclude<DraftEndOutcome, 'disconnected'>,
    areaId: string | null,
  ): Promise<void> {
    this.#stopTimers(draft);
    if (connection.draft === draft) connection.draft = null;
    connection.invalid.rememberOwned(draft.draftId, this.#deps.clock.now());
    const owned = await this.#stillOwns(draft, connection, () =>
      this.#deps.registry.release(draft.draftId, connection.id),
    );
    if (owned) await this.#publishEnded(connection, draft, outcome, areaId);
    this.#deps.audit.draftEnded(connection, draft.draftId, areaId, outcome);
    this.#deps.onStatusChanged(connection);
  }

  /**
   * Whether this connection still owned the draft when `op` (release / markDisconnected) ran. A failed compare means
   * "not owned" only when another connection owns the record now; no record (or Redis down) keeps the end announced.
   */
  async #stillOwns(draft: ActiveDraft, connection: Connection, op: () => Promise<boolean>): Promise<boolean> {
    if (draft.localOnly || (await op())) return true;
    const owner = await this.#deps.registry.getOwner(draft.draftId);
    return owner === null || owner.connectionId === connection.id;
  }

  #expire(connection: Connection, draft: ActiveDraft): void {
    if (connection.draft !== draft) return;
    this.#log.info({ connectionId: connection.id, draftId: draft.draftId }, 'draft expired (idle)');
    runDetached(this.#finish(connection, draft, 'expired', draft.areaId), this.#log, 'draft.expire');
  }

  #keepAlive(connection: Connection, draft: ActiveDraft): void {
    this.#armIdle(connection, draft);
    if (!draft.localOnly) {
      runDetached(this.#deps.registry.touch(draft.draftId, connection.id), this.#log, 'draft.touch');
    }
  }

  #armIdle(connection: Connection, draft: ActiveDraft): void {
    draft.cancelIdle?.();
    draft.cancelIdle = unrefTimeout(() => {
      draft.cancelIdle = null;
      this.#expire(connection, draft);
    }, this.#deps.config.REALTIME_DRAFT_IDLE_MS);
  }

  /** Cancelled BEFORE any draft.ended: a pending trailing update is discarded, keyframes stop. */
  #stopTimers(draft: ActiveDraft): void {
    draft.coalescer.cancel();
    draft.cancelIdle?.();
    draft.cancelIdle = null;
  }

  #notFound(connection: Connection, draftId: string, ref: string | null, type: string): void {
    connection.send(
      errorMessage('DRAFT_NOT_FOUND', `Draft ${draftId} is not active on this connection.`, { ref }),
    );
    const verdict = connection.invalid.recordDraftNotFound(draftId, this.#deps.clock.now());
    if (verdict.counted) this.#deps.metrics.wsMessagesDroppedTotal.inc({ type, reason: 'invalid' });
    if (verdict.close) connection.close(CLOSE_CODES.INVALID_MESSAGES, 'too many invalid messages');
  }

  #owner(connection: Connection) {
    return {
      userId: connection.identity.userId,
      sessionId: connection.identity.sessionId,
      connectionId: connection.id,
      instanceId: this.#deps.instanceId,
    };
  }

  async #publishUpdated(
    connection: Connection,
    draftId: string,
    areaId: string | null,
    frame: DraftFrame,
  ): Promise<void> {
    await this.#deps.events.publish('drafts', {
      kind: 'updated',
      draftId,
      connectionId: connection.id,
      user: userRef(connection),
      areaId,
      rev: frame.rev,
      vertices: frame.vertices,
      cursor: frame.cursor,
      bbox: frame.bbox,
    });
  }

  async #publishEnded(
    connection: Connection,
    draft: ActiveDraft,
    outcome: DraftEndOutcome,
    areaId: string | null,
  ): Promise<void> {
    await this.#deps.events.publish('drafts', {
      kind: 'ended',
      draftId: draft.draftId,
      connectionId: connection.id,
      user: userRef(connection),
      areaId,
      outcome,
      bbox: draft.coalescer.latest?.bbox ?? null,
    });
  }
}

function userRef(connection: Connection): { id: string; displayName: string; color: string } {
  const { identity } = connection;
  return { id: identity.userId, displayName: identity.displayName, color: identity.color };
}

/** Re-quantises to 6 dp (section 7.6) and computes the bbox of vertices + cursor for interest filtering. */
export function toFrame(data: DraftUpdateData): DraftFrame {
  const vertices: Position[] = data.vertices.map((position) => quantizePosition(position, DRAFT_DECIMALS));
  const cursor = data.cursor === null ? null : quantizePosition(data.cursor, DRAFT_DECIMALS);
  const bbox = bboxOfPositions(cursor === null ? vertices : [...vertices, cursor]);
  return { rev: data.rev, vertices, cursor, bbox };
}
