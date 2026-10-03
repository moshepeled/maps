/**
 * Audit trail of the realtime gateway (SPEC section 10.4): `ws.connect` / `ws.disconnect` (with the per-type counts of trail 3)
 * and the draft/lock lifecycle go to `container.audit`; the high-frequency denials - `ws.reject`, denied `draft.*` and
 * `lock.*`, the WS `ratelimit.hit` - go ONLY through `container.auditCoalescer`, so a flooding client produces a bounded
 * number of rows.
 */
import type { AuditCoalescer, AuditEvent, AuditLogger } from '../../infra/audit/types.js';
import type { Connection } from './connection.js';

export type WsRejectReason = 'origin' | 'ticket' | 'session' | 'capacity' | 'protocol' | 'revalidation';
export type DeniedAction = 'draft.start' | 'draft.end' | 'lock.acquire';

/** Request metadata of a rejected upgrade (no connection exists yet). */
export interface RejectContext {
  ip: string | null;
  userAgent: string | null;
  requestId: string | null;
  userId?: string | null;
  sessionId?: string | null;
}

export class RealtimeAudit {
  readonly #audit: AuditLogger;
  readonly #coalescer: AuditCoalescer;
  readonly #instanceId: string;

  constructor(audit: AuditLogger, coalescer: AuditCoalescer, instanceId: string) {
    this.#audit = audit;
    this.#coalescer = coalescer;
    this.#instanceId = instanceId;
  }

  connected(connection: Connection): void {
    this.#audit.record({
      ...this.#connectionFields(connection),
      action: 'ws.connect',
      outcome: 'success',
      targetType: 'ws_connection',
      targetId: connection.id,
      details: { instanceId: this.#instanceId },
    });
  }

  disconnected(connection: Connection, code: number, now: number): void {
    this.#audit.record({
      ...this.#connectionFields(connection),
      action: 'ws.disconnect',
      outcome: 'success',
      targetType: 'ws_connection',
      targetId: connection.id,
      details: {
        instanceId: this.#instanceId,
        code,
        durationMs: Math.max(0, now - connection.connectedAt),
        messagesIn: connection.messagesIn,
        messagesOut: connection.messagesOut,
        counts: { ...connection.counts, invalid: connection.invalid.total },
      },
    });
  }

  /** Coalesced per (reason, IP) per 10 s. */
  rejected(reason: WsRejectReason, context: RejectContext): void {
    this.#coalescer.record(`ws.reject:${reason}:${context.ip ?? 'unknown'}`, {
      action: 'ws.reject',
      outcome: 'denied',
      actorId: context.userId ?? null,
      sessionId: context.sessionId ?? null,
      targetType: 'ws_connection',
      targetId: null,
      requestId: context.requestId,
      ip: context.ip,
      userAgent: context.userAgent,
      details: { reason },
    });
  }

  /** Coalesced per (action, code, connection) per 10 s; `targetId` is the draft or area id. */
  denied(
    action: DeniedAction,
    code: string,
    connection: Connection,
    targetId: string,
    extra: Record<string, unknown> = {},
  ): void {
    this.#coalescer.record(`${action}:denied:${code}:${connection.id}`, {
      ...this.#connectionFields(connection),
      action,
      outcome: 'denied',
      targetType: action.startsWith('draft.') ? 'draft' : 'area',
      targetId,
      details: { code, ...extra },
    });
  }

  /** The WS leg of the drawing-action limit (section 10.1): coalesced per user per 10 s. */
  drawRateLimitHit(connection: Connection, limit: number): void {
    this.#coalescer.record(`ratelimit:draw:${connection.identity.userId}`, {
      ...this.#connectionFields(connection),
      action: 'ratelimit.hit',
      outcome: 'denied',
      targetType: 'user',
      targetId: connection.identity.userId,
      details: { scope: 'draw', kind: 'draft.start', transport: 'ws', limit },
    });
  }

  draftStarted(connection: Connection, draftId: string, areaId: string | null, resume: boolean): void {
    this.#lifecycle(connection, 'draft.start', 'draft', draftId, { areaId, resume });
  }

  draftEnded(connection: Connection, draftId: string, areaId: string | null, outcome: string): void {
    this.#lifecycle(connection, 'draft.end', 'draft', draftId, { areaId, outcome });
  }

  lockAcquired(connection: Connection, areaId: string, scope: string): void {
    this.#lifecycle(connection, 'lock.acquire', 'area', areaId, {
      holderUserId: connection.identity.userId,
      scope,
    });
  }

  lockReleased(connection: Connection, areaId: string, reason: 'client' | 'disconnect'): void {
    this.#lifecycle(connection, 'lock.release', 'area', areaId, { reason });
  }

  #lifecycle(
    connection: Connection,
    action: AuditEvent['action'],
    targetType: 'draft' | 'area',
    targetId: string,
    details: Record<string, unknown>,
  ): void {
    this.#audit.record({
      ...this.#connectionFields(connection),
      action,
      outcome: 'success',
      targetType,
      targetId,
      details,
    });
  }

  #connectionFields(
    connection: Connection,
  ): Pick<AuditEvent, 'actorId' | 'sessionId' | 'requestId' | 'ip' | 'userAgent'> {
    return {
      actorId: connection.identity.userId,
      sessionId: connection.identity.sessionId,
      requestId: connection.requestId,
      ip: connection.ip,
      userAgent: connection.userAgent,
    };
  }
}
