/**
 * SQL of the retention job (SPEC section 5.6): the purges, the run record and the advisory lock of the dedicated lock
 * session (`run-lock.ts` orchestrates it). Each purge deletes at most one batch; the caller runs every batch in its own
 * transaction with the retention timeouts. The area purge also raises the change-feed watermark to the highest
 * `change_seq` of the versions it removes (in the same statement, hence the same transaction), so clients asking for
 * changes older than the watermark get 410 and reload instead of silently missing purged history.
 */
import type pg from 'pg';

import { runNamed } from '../../infra/db/execute.js';
import type { Db, DbTx, NamedSql } from '../../infra/db/types.js';
import { sql } from '../../infra/db/types.js';
import type { Metrics } from '../../infra/metrics/metrics.js';
import type { LockSession } from './run-lock.js';

const PURGE_AREAS = sql(
  'retention.purgeAreas',
  `WITH doomed AS (
     SELECT id FROM areas
     WHERE deleted_at < now() - make_interval(days => $1)
     ORDER BY deleted_at
     LIMIT $2
     FOR UPDATE SKIP LOCKED
   ), wm AS (
     SELECT COALESCE(max(v.change_seq), 0) AS m FROM area_versions v JOIN doomed d ON d.id = v.area_id
   ), upd AS (
     UPDATE system_state SET value = to_jsonb(GREATEST((value)::text::bigint, (SELECT m FROM wm))), updated_at = now()
     WHERE key = 'change_feed_purge_watermark'
   )
   DELETE FROM areas a USING doomed d WHERE a.id = d.id RETURNING a.id`,
);

const PURGE_AUDIT = sql(
  'retention.purgeAudit',
  `DELETE FROM audit_logs WHERE id IN (
     SELECT id FROM audit_logs WHERE occurred_at < now() - make_interval(days => $1) ORDER BY id LIMIT $2)
   RETURNING id`,
);

const PURGE_SESSIONS = sql(
  'retention.purgeSessions',
  `DELETE FROM sessions WHERE id IN (
     SELECT id FROM sessions
     WHERE expires_at < now() - make_interval(days => $1) OR revoked_at < now() - make_interval(days => $1)
     LIMIT $2)
   RETURNING id`,
);

const RECORD_LAST_RUN = sql(
  'retention.recordLastRun',
  `UPDATE system_state SET value = $1::jsonb, updated_at = now() WHERE key = 'retention_last_run'`,
);

/** Session-level advisory lock of the job (section 5.6); non-blocking, so a busy lock means "another instance runs". */
const TRY_LOCK = sql('retention.tryLock', 'SELECT pg_try_advisory_lock($1::bigint) AS locked');
const UNLOCK = sql('retention.unlock', 'SELECT pg_advisory_unlock($1::bigint) AS unlocked');

export interface PurgeCounts {
  areas: number;
  audit: number;
  sessions: number;
}

/** The purge statement of each entity: `$1` = age in days, `$2` = batch size, returning the deleted ids. */
const PURGES: Record<keyof PurgeCounts, NamedSql> = {
  areas: PURGE_AREAS,
  audit: PURGE_AUDIT,
  sessions: PURGE_SESSIONS,
};

/**
 * The `retention_last_run` record (section 5.6 `{ at, purged, durationMs }`, plus how the run ended). A failed or stopped
 * run is recorded too: its batches committed before the failure, so `purged` shows what it actually removed.
 */
export interface RetentionLastRun {
  at: string;
  purged: PurgeCounts;
  durationMs: number;
  status: 'completed' | 'failed' | 'stopped';
  /** The error code of a failed run (SQLSTATE or driver code, `unknown` otherwise). */
  reason?: string;
}

export interface RetentionRepository {
  /**
   * Hard-deletes one batch of `entity` rows older than `days` (areas: soft-deleted that long ago, versions cascade);
   * returns the count.
   */
  purgeBatch(tx: DbTx, entity: keyof PurgeCounts, days: number, batchSize: number): Promise<number>;
  recordLastRun(run: RetentionLastRun): Promise<void>;
  /** A dedicated pooled connection for the advisory lock. */
  connectLockSession(): Promise<LockSession>;
}

export function createRetentionRepository(db: Db, metrics: Metrics): RetentionRepository {
  return {
    async purgeBatch(tx, entity, days, batchSize) {
      return (await tx.query<{ id: string | number }>(PURGES[entity], [days, batchSize])).length;
    },
    async recordLastRun(run) {
      await db.query(RECORD_LAST_RUN, [JSON.stringify(run)]);
    },
    async connectLockSession() {
      const client: pg.PoolClient = await db.pool.connect();
      return {
        async tryLock(key) {
          const [row] = await runNamed<{ locked: boolean }>(client, metrics, TRY_LOCK, [key]);
          return row?.locked === true;
        },
        async unlock(key) {
          const [row] = await runNamed<{ unlocked: boolean }>(client, metrics, UNLOCK, [key]);
          return row?.unlocked === true;
        },
        release: (error?: Error) => {
          client.release(error);
        },
      };
    },
  };
}
