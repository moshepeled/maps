/**
 * One retention run (SPEC section 5.6): under the advisory lock, purge soft-deleted areas (with their versions, raising the
 * change-feed watermark), old audit rows and dead sessions, each in batches that run in their OWN transaction with
 * `withTransaction(fn, { timeoutMs: RETENTION_STATEMENT_TIMEOUT_MS })` (so a long cascade is cut neither by the pool's
 * 5 s statement timeout nor by its 6 s client read timeout), until a batch deletes fewer rows than its size. Every run
 * that held the lock records `retention_last_run` (completed, failed or stopped, with what it purged) while it still
 * holds the lock, so an older run can never overwrite a newer run's record; every run that was not skipped emits the
 * `retention.run` audit event, and each batch increments the purge counters.
 */
import type { AppConfig } from '../../config/env.js';
import type { AuditLogger } from '../../infra/audit/types.js';
import type { Clock } from '../../infra/clock.js';
import { pgErrorCode } from '../../infra/db/execute.js';
import type { Db } from '../../infra/db/types.js';
import type { Logger } from '../../infra/logger.js';
import type { Metrics } from '../../infra/metrics/metrics.js';
import type { PurgeCounts, RetentionLastRun, RetentionRepository } from './retention.repository.js';
import { withAdvisoryLock } from './run-lock.js';

/** Areas cascade to their versions, so their batches stay small whatever RETENTION_BATCH_SIZE says. */
export const MAX_AREA_BATCH_SIZE = 200;

export type RetentionSettings = Pick<
  AppConfig,
  | 'AREA_PURGE_AFTER_DAYS'
  | 'AUDIT_RETENTION_DAYS'
  | 'SESSION_PURGE_AFTER_DAYS'
  | 'RETENTION_BATCH_SIZE'
  | 'RETENTION_STATEMENT_TIMEOUT_MS'
>;

/** A run that took the lock, or failed while taking it: its `retention_last_run` record plus the error of a failed one. */
export type RetentionRun = RetentionLastRun & { error?: unknown };

export type RetentionRunResult = { status: 'skipped' } | RetentionRun;

export interface RetentionServiceDeps {
  db: Pick<Db, 'withTransaction'>;
  repository: RetentionRepository;
  audit: AuditLogger;
  metrics: Pick<Metrics, 'retentionPurgedTotal'>;
  logger: Logger;
  clock: Clock;
  settings: RetentionSettings;
}

type Entity = keyof PurgeCounts;

export class RetentionService {
  readonly #deps: RetentionServiceDeps;
  #stopRequested = false;

  constructor(deps: RetentionServiceDeps) {
    this.#deps = deps;
  }

  /** Finishes the batch in progress, then stops the run (called during shutdown). */
  requestStop(): void {
    this.#stopRequested = true;
  }

  /** One run; never throws. `skipped` when another instance holds the lock. */
  async runOnce(): Promise<RetentionRunResult> {
    const { clock, logger, repository } = this.#deps;
    const started = clock.now();
    let run: RetentionRun;
    try {
      const outcome = await withAdvisoryLock(
        () => repository.connectLockSession(),
        () => this.#runLocked(started),
        logger,
      );
      if (!outcome.acquired) {
        logger.debug('retention skipped: another instance holds the lock');
        return { status: 'skipped' };
      }
      run = outcome.value;
    } catch (error) {
      // The lock was never held (connect or pg_try_advisory_lock failed): nothing was purged and nothing is recorded,
      // so another instance's retention_last_run is left alone.
      run = {
        at: new Date(started).toISOString(),
        purged: emptyCounts(),
        durationMs: clock.now() - started,
        status: 'failed',
        reason: pgErrorCode(error),
        error,
      };
    }
    this.#report(run);
    return run;
  }

  /**
   * The part of a run that needs the lock. The run record is written BEFORE the lock is released: written after it,
   * another instance could take the lock, finish and record its newer run in between, and this older record would then
   * overwrite it. Never throws: batches committed before a failure or stop are real purges and are recorded too.
   */
  async #runLocked(started: number): Promise<RetentionRun> {
    const { clock, logger, repository } = this.#deps;
    const purged = emptyCounts();
    const record: RetentionLastRun = {
      at: new Date(started).toISOString(),
      purged,
      durationMs: 0,
      status: 'completed',
    };
    let error: unknown;
    try {
      record.status = await this.#purgeAll(purged);
    } catch (caught) {
      error = caught;
      record.status = 'failed';
      record.reason = pgErrorCode(caught);
    }
    record.durationMs = clock.now() - started;
    try {
      await repository.recordLastRun(record);
    } catch (recordError) {
      // Best effort: the record is observability, so failing to write it never fails (or re-fails) the run.
      logger.warn({ err: recordError, run: record }, 'retention_last_run could not be recorded');
    }
    return record.status === 'failed' ? { ...record, error } : record;
  }

  /** The `retention.run` audit event and the log line of a run that was not skipped. */
  #report(run: RetentionRun): void {
    const { logger } = this.#deps;
    const { purged, durationMs } = run;
    switch (run.status) {
      case 'completed':
        this.#recordAudit('success', { purged, durationMs });
        logger.info({ purged, durationMs }, 'retention run completed');
        return;
      case 'stopped':
        this.#recordAudit('failure', { purged, durationMs, reason: 'stopped' });
        logger.info({ purged, durationMs }, 'retention run stopped by shutdown');
        return;
      case 'failed':
        this.#recordAudit('failure', { purged, durationMs, reason: run.reason });
        logger.error({ err: run.error, purged, durationMs }, 'retention run failed');
    }
  }

  /**
   * Areas, then audit rows, then sessions. Each entity is purged in batches until one deletes fewer rows than its
   * size; progress is counted per batch (partial runs included). `stopped` when a stop was requested between batches.
   */
  async #purgeAll(purged: PurgeCounts): Promise<'completed' | 'stopped'> {
    const { db, metrics, repository, settings } = this.#deps;
    const plan: [Entity, number, number][] = [
      ['areas', settings.AREA_PURGE_AFTER_DAYS, Math.min(settings.RETENTION_BATCH_SIZE, MAX_AREA_BATCH_SIZE)],
      ['audit', settings.AUDIT_RETENTION_DAYS, settings.RETENTION_BATCH_SIZE],
      ['sessions', settings.SESSION_PURGE_AFTER_DAYS, settings.RETENTION_BATCH_SIZE],
    ];
    for (const [entity, days, batchSize] of plan) {
      for (;;) {
        if (this.#stopRequested) return 'stopped';
        const deleted = await db.withTransaction((tx) => repository.purgeBatch(tx, entity, days, batchSize), {
          timeoutMs: settings.RETENTION_STATEMENT_TIMEOUT_MS,
        });
        purged[entity] += deleted;
        if (deleted > 0) metrics.retentionPurgedTotal.inc({ entity }, deleted);
        if (deleted < batchSize) break;
      }
    }
    return 'completed';
  }

  #recordAudit(outcome: 'success' | 'failure', details: Record<string, unknown>): void {
    this.#deps.audit.record({
      action: 'retention.run',
      outcome,
      actorId: null,
      targetType: 'system',
      targetId: null,
      details,
    });
  }
}

function emptyCounts(): PurgeCounts {
  return { areas: 0, audit: 0, sessions: 0 };
}
