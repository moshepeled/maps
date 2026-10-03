/**
 * Admin reads of the audit trail (SPEC section 6.4, section 10.4). Every successful call is audited as `admin.audit_query` with the
 * endpoint and the filters (reading the trail is a security event); refusals (403 -> denied) and failures get the
 * generic `{ code, status }` row from the audit hook, so no outcome escapes the trail.
 */
import { LIMITS } from '@snapland/shared';
import type {
  AuditLogListResponse,
  AuditLogQuery,
  AuditStatsQuery,
  AuditStatsResponse,
} from '@snapland/shared';

import type { AuditLogger } from '../../infra/audit/types.js';
import type { Clock } from '../../infra/clock.js';
import type { Db } from '../../infra/db/types.js';
import type { UserDirectory } from '../../infra/directory/types.js';
import type { ActorContext } from '../../infra/http/request-context.js';
import { actorAuditFields } from '../auth/auth-context.js';
import {
  toActionsByHour,
  toAuditLogDto,
  toConflictRate,
  toRateLimitHits,
  toTopEditors,
} from './admin.mapper.js';
import {
  actionsHourly,
  conflictsDaily,
  listAuditLogs,
  rateLimitDaily,
  topEditors,
} from './admin.repository.js';
import type { AuditLogFilters } from './admin.repository.js';
import { decodeAuditCursor, encodeAuditCursor } from './audit-cursor.js';
import { resolveStatsWindow } from './stats-window.js';

export interface AdminServiceDeps {
  db: Db;
  users: UserDirectory;
  audit: AuditLogger;
  clock: Clock;
}

/** Absent filters become NULL parameters; timestamps become instants. */
function toAuditLogFilters(query: AuditLogQuery): AuditLogFilters {
  return {
    actorId: query.actorId ?? null,
    action: query.action ?? null,
    outcome: query.outcome ?? null,
    from: query.from === undefined ? null : new Date(query.from),
    to: query.to === undefined ? null : new Date(query.to),
  };
}

export class AdminService {
  readonly #deps: AdminServiceDeps;

  constructor(deps: AdminServiceDeps) {
    this.#deps = deps;
  }

  async listAuditLogs(query: AuditLogQuery, actor: ActorContext): Promise<AuditLogListResponse> {
    const filters = toAuditLogFilters(query);
    const limit = query.limit ?? LIMITS.auditLogsLimitDefault;
    const beforeId = query.cursor === undefined ? null : decodeAuditCursor(query.cursor, filters);
    // One extra row tells whether another page exists without a count query.
    const rows = await listAuditLogs(this.#deps.db, filters, beforeId, limit + 1);
    const page = rows.slice(0, limit);
    const last = page.at(-1);
    const nextCursor = rows.length > limit && last !== undefined ? encodeAuditCursor(last.id, filters) : null;
    this.#recordSuccess(actor, 'audit-logs', query);
    return { items: page.map(toAuditLogDto), nextCursor };
  }

  async auditStats(query: AuditStatsQuery, actor: ActorContext): Promise<AuditStatsResponse> {
    const { db, users, clock } = this.#deps;
    const { from, to } = resolveStatsWindow(query, clock.now());
    const [actions, editors, conflicts, rateLimits] = await Promise.all([
      actionsHourly(db, from, to),
      topEditors(db, from, to),
      conflictsDaily(db, from, to),
      rateLimitDaily(db, from, to),
    ]);
    const profiles = await users.getProfiles(editors.map((row) => row.actor_id));
    const displayNames = new Map([...profiles].map(([id, profile]) => [id, profile.displayName]));
    this.#recordSuccess(actor, 'audit-stats', { from: from.toISOString(), to: to.toISOString() });
    return {
      from: from.toISOString(),
      to: to.toISOString(),
      actionsByHour: toActionsByHour(actions),
      topEditors: toTopEditors(editors, displayNames),
      conflictRate: toConflictRate(conflicts),
      rateLimitHits: toRateLimitHits(rateLimits),
    };
  }

  #recordSuccess(
    actor: ActorContext,
    endpoint: 'audit-logs' | 'audit-stats',
    filters: Record<string, unknown>,
  ): void {
    this.#deps.audit.record({
      ...actorAuditFields(actor),
      action: 'admin.audit_query',
      outcome: 'success',
      targetType: 'system',
      targetId: null,
      details: { endpoint, filters },
    });
  }
}
