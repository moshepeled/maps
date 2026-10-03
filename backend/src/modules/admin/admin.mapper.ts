/** Rows of `admin.repository.ts` -> the DTOs of SPEC section 6.4 (ISO-8601 UTC timestamps, camelCase keys). */
import type { AuditLogDto, AuditStatsResponse } from '@snapland/shared';

import type {
  ActionsHourlyRow,
  AuditLogRow,
  ConflictsDailyRow,
  EditorTotalsRow,
  RateLimitDailyRow,
} from './admin.repository.js';

export function toAuditLogDto(row: AuditLogRow): AuditLogDto {
  return {
    id: row.id,
    occurredAt: row.occurred_at.toISOString(),
    action: row.action,
    outcome: row.outcome,
    actorId: row.actor_id,
    sessionId: row.session_id,
    targetType: row.target_type,
    targetId: row.target_id,
    requestId: row.request_id,
    instanceId: row.instance_id,
    ip: row.ip,
    userAgent: row.user_agent,
    details: row.details,
  };
}

type Stats = AuditStatsResponse;

export function toActionsByHour(rows: readonly ActionsHourlyRow[]): Stats['actionsByHour'] {
  return rows.map((row) => ({
    hour: row.hour.toISOString(),
    action: row.action,
    outcome: row.outcome,
    events: row.events,
    actors: row.actors,
  }));
}

export function toTopEditors(
  rows: readonly EditorTotalsRow[],
  displayNames: ReadonlyMap<string, string>,
): Stats['topEditors'] {
  return rows.map((row) => ({
    actorId: row.actor_id,
    displayName: displayNames.get(row.actor_id) ?? null,
    creates: row.creates,
    updates: row.updates,
    deletesRestores: row.deletes_restores,
  }));
}

/** rate = conflicts / (successful updates + conflicts): the share of update attempts that ended in a conflict. */
export function conflictRate(updates: number, conflicts: number): number {
  const attempts = updates + conflicts;
  return attempts === 0 ? 0 : conflicts / attempts;
}

export function toConflictRate(rows: readonly ConflictsDailyRow[]): Stats['conflictRate'] {
  return rows.map((row) => ({
    day: row.day.toISOString(),
    updates: row.updates,
    merged: row.merged,
    conflicts: row.conflicts,
    rate: conflictRate(row.updates, row.conflicts),
  }));
}

export function toRateLimitHits(rows: readonly RateLimitDailyRow[]): Stats['rateLimitHits'] {
  return rows.map((row) => ({ day: row.day.toISOString(), scope: row.scope, hits: row.hits }));
}
