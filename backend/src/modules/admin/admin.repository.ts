/**
 * SQL of the admin module (SPEC section 5.2, section 6.4, section 10.4): row-level drill-down into `audit_logs` (keyset on `id DESC`) and
 * the four analytics aggregates. The aggregates read the BASE TABLE bounded by `occurred_at >= $1 AND occurred_at < $2`
 * - never the 0008 views, whose `date_trunc` columns no index can serve - so the BRIN index on `occurred_at` bounds
 * every scan (asserted by `IT/platform/audit-analytics`). The window is each statement's ONLY row predicate: the
 * views' action/actor restrictions become `FILTER` clauses plus a `HAVING`, so every aggregate is one BRIN-bounded
 * scan whose cost depends on the window alone (<= 31 days), never on a plan that flips between the btree indexes and
 * the BRIN with the data distribution. Buckets are UTC days/hours (explicit time zone).
 */
import type { AuditOutcome } from '@snapland/shared';

import type { DbTx } from '../../infra/db/types.js';
import { sql } from '../../infra/db/types.js';

export interface AuditLogFilters {
  actorId: string | null;
  action: string | null;
  outcome: string | null;
  from: Date | null;
  to: Date | null;
}

/** `outcome` is guaranteed by the `audit_logs_outcome_ck` CHECK. */
export interface AuditLogRow {
  id: number;
  occurred_at: Date;
  action: string;
  outcome: AuditOutcome;
  actor_id: string | null;
  session_id: string | null;
  target_type: string | null;
  target_id: string | null;
  request_id: string | null;
  instance_id: string;
  ip: string | null;
  user_agent: string | null;
  details: Record<string, unknown>;
}

export interface ActionsHourlyRow {
  hour: Date;
  action: string;
  outcome: AuditOutcome;
  events: number;
  actors: number;
}

export interface EditorTotalsRow {
  actor_id: string;
  creates: number;
  updates: number;
  deletes_restores: number;
}

export interface ConflictsDailyRow {
  day: Date;
  updates: number;
  merged: number;
  conflicts: number;
}

export interface RateLimitDailyRow {
  day: Date;
  scope: string | null;
  hits: number;
}

/**
 * One static statement; absent filters are NULL parameters (dynamic SQL would need 32 pre-written variants). The
 * keyset walks `id DESC` and stops after `limit + 1` matches, so a page never scans more than the rows up to its last
 * match; a selective `actor_id`/`action` filter can additionally use its btree index under a custom plan.
 */
const LIST_AUDIT_LOGS = sql(
  'admin.listAuditLogs',
  `SELECT id, occurred_at, action, outcome, actor_id, session_id, target_type, target_id, request_id, instance_id,
        host(ip) AS ip, user_agent, details
   FROM audit_logs
   WHERE ($1::uuid IS NULL OR actor_id = $1)
     AND ($2::text IS NULL OR action = $2)
     AND ($3::text IS NULL OR outcome = $3)
     AND ($4::timestamptz IS NULL OR occurred_at >= $4)
     AND ($5::timestamptz IS NULL OR occurred_at < $5)
     AND ($6::bigint IS NULL OR id < $6)
   ORDER BY id DESC
   LIMIT $7`,
);

/** The four analytics statements, each with the expressions of its 0008 view (the BRIN proof EXPLAINs exactly these). */
export const AUDIT_STATS_SQL = {
  actionsHourly: sql(
    'admin.statsActionsHourly',
    `SELECT date_trunc('hour', occurred_at, 'UTC') AS hour, action, outcome, count(*)::bigint AS events,
            count(DISTINCT actor_id)::bigint AS actors
     FROM audit_logs
     WHERE occurred_at >= $1 AND occurred_at < $2
     GROUP BY 1, 2, 3
     ORDER BY 1, 2, 3`,
  ),
  /** `audit_editor_activity_daily` per day and actor, summed over the window: the top 20 editors. */
  editorsDaily: sql(
    'admin.statsEditorsDaily',
    `SELECT actor_id, sum(creates)::bigint AS creates, sum(updates)::bigint AS updates,
            sum(deletes_restores)::bigint AS deletes_restores
     FROM (
       SELECT date_trunc('day', occurred_at, 'UTC') AS day, actor_id,
              count(*) FILTER (WHERE action = 'area.create' AND outcome = 'success') AS creates,
              count(*) FILTER (WHERE action = 'area.update' AND outcome = 'success') AS updates,
              count(*) FILTER (WHERE action IN ('area.delete', 'area.restore') AND outcome = 'success') AS deletes_restores
       FROM audit_logs
       WHERE occurred_at >= $1 AND occurred_at < $2
       GROUP BY 1, 2
       -- The view's "actor_id IS NOT NULL AND action LIKE 'area.%'", as an aggregate so it stays out of the WHERE.
       HAVING count(*) FILTER (WHERE actor_id IS NOT NULL AND action LIKE 'area.%') > 0
     ) daily
     GROUP BY actor_id
     ORDER BY sum(creates) + sum(updates) + sum(deletes_restores) DESC, actor_id
     LIMIT 20`,
  ),
  conflictsDaily: sql(
    'admin.statsConflictsDaily',
    `SELECT date_trunc('day', occurred_at, 'UTC') AS day,
            count(*) FILTER (WHERE action = 'area.update' AND outcome = 'success')::bigint AS updates,
            count(*) FILTER (WHERE action = 'area.update' AND outcome = 'success'
                               AND details ->> 'merged' = 'true')::bigint AS merged,
            count(*) FILTER (WHERE action = 'area.conflict')::bigint AS conflicts
     FROM audit_logs
     WHERE occurred_at >= $1 AND occurred_at < $2
     GROUP BY 1
     HAVING count(*) FILTER (WHERE action IN ('area.update', 'area.conflict')) > 0
     ORDER BY 1`,
  ),
  /** Coalesced rows count `details.count` hits. */
  rateLimitDaily: sql(
    'admin.statsRateLimitDaily',
    `SELECT date_trunc('day', occurred_at, 'UTC') AS day, details ->> 'scope' AS scope,
            (sum(COALESCE((details ->> 'count')::bigint, 1)) FILTER (WHERE action = 'ratelimit.hit'))::bigint AS hits
     FROM audit_logs
     WHERE occurred_at >= $1 AND occurred_at < $2
     GROUP BY 1, 2
     HAVING count(*) FILTER (WHERE action = 'ratelimit.hit') > 0
     ORDER BY 1, 2`,
  ),
} as const;

export function listAuditLogs(
  db: DbTx,
  filters: AuditLogFilters,
  beforeId: number | null,
  limit: number,
): Promise<AuditLogRow[]> {
  return db.query<AuditLogRow>(LIST_AUDIT_LOGS, [
    filters.actorId,
    filters.action,
    filters.outcome,
    filters.from,
    filters.to,
    beforeId,
    limit,
  ]);
}

export function actionsHourly(db: DbTx, from: Date, to: Date): Promise<ActionsHourlyRow[]> {
  return db.query<ActionsHourlyRow>(AUDIT_STATS_SQL.actionsHourly, [from, to]);
}

export function topEditors(db: DbTx, from: Date, to: Date): Promise<EditorTotalsRow[]> {
  return db.query<EditorTotalsRow>(AUDIT_STATS_SQL.editorsDaily, [from, to]);
}

export function conflictsDaily(db: DbTx, from: Date, to: Date): Promise<ConflictsDailyRow[]> {
  return db.query<ConflictsDailyRow>(AUDIT_STATS_SQL.conflictsDaily, [from, to]);
}

export function rateLimitDaily(db: DbTx, from: Date, to: Date): Promise<RateLimitDailyRow[]> {
  return db.query<RateLimitDailyRow>(AUDIT_STATS_SQL.rateLimitDaily, [from, to]);
}
