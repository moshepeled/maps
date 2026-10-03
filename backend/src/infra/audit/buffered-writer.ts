/**
 * Production audit writer (SPEC section 10.4): `record()` normalises the event, logs it at `info` with `audit: true` (the
 * second trail) and pushes it onto a bounded in-memory queue - it never blocks and never throws. Batches of
 * `AUDIT_BATCH_SIZE` are written with ONE multi-row `INSERT ... SELECT * FROM unnest(...)` when the batch fills or every
 * `AUDIT_FLUSH_INTERVAL_MS`.
 *
 * A failed batch is either transient or not. Transient (connection loss, admin shutdown, too many connections,
 * timeouts, lock contention): the events stay queued and the write is retried after 1 s, 2 s, 4 s ... (cap 30 s).
 * Anything else: the batch is inserted one row at a time, so only the offending rows are dropped (`rejected`) and one
 * poison row can never block the queue. A full queue drops the NEW event (`dropped`, error log at most every 10 s).
 * `close()` flushes once with a 5 s budget; whatever is still queued then is counted as `failed`, and a batch that
 * fails after that is counted `failed` too, never retried.
 */
import type { Clock } from '../clock.js';
import { isConnectionFailure } from '../db/errors.js';
import { pgErrorCode } from '../db/execute.js';
import type { Db } from '../db/types.js';
import { sql } from '../db/types.js';
import type { Lifecycle } from '../lifecycle.js';
import { runDetached } from '../lifecycle.js';
import type { Logger } from '../logger.js';
import type { Metrics } from '../metrics/metrics.js';
import { withTimeout } from '../timeout.js';
import { normalizeAuditEvent } from './normalize.js';
import type { NormalizedAuditEvent } from './normalize.js';
import type { AuditEvent, AuditLogger } from './types.js';

/** One statement for the whole batch: 12 parallel arrays unnested into rows (section 10.4). */
export const INSERT_AUDIT_BATCH = sql(
  'audit.insertBatch',
  `INSERT INTO audit_logs (occurred_at, action, outcome, actor_id, session_id, target_type, target_id, request_id,
                         instance_id, ip, user_agent, details)
SELECT * FROM unnest($1::timestamptz[], $2::text[], $3::text[], $4::uuid[], $5::uuid[], $6::text[], $7::text[],
                     $8::text[], $9::text[], $10::inet[], $11::text[], $12::jsonb[])`,
);

const SHUTDOWN_FLUSH_BUDGET_MS = 5000;
const RETRY_BASE_MS = 1000;
export const RETRY_MAX_MS = 30_000;
const LOG_INTERVAL_MS = 10_000;

/** Timeouts and lock contention: like a connection failure, the same batch succeeds once the condition passes. */
const TRANSIENT_CODES = new Set([
  '57014', // query_canceled (statement timeout)
  '40001', // serialization_failure
  '40P01', // deadlock_detected
  '55P03', // lock_not_available
]);

/** Whether a failed insert should be retried with the same rows (section 10.4). */
export function isTransientAuditError(error: unknown): boolean {
  return (
    isConnectionFailure(error) ||
    TRANSIENT_CODES.has(pgErrorCode(error)) ||
    (error instanceof Error && error.message === 'Query read timeout')
  );
}

/** The 12 parallel arrays bound to `INSERT_AUDIT_BATCH`. */
export function toInsertParams(events: readonly NormalizedAuditEvent[], instanceId: string): unknown[][] {
  return [
    events.map((event) => event.occurredAt),
    events.map((event) => event.action),
    events.map((event) => event.outcome),
    events.map((event) => event.actorId),
    events.map((event) => event.sessionId),
    events.map((event) => event.targetType),
    events.map((event) => event.targetId),
    events.map((event) => event.requestId),
    events.map(() => instanceId),
    events.map((event) => event.ip),
    events.map((event) => event.userAgent),
    events.map((event) => JSON.stringify(event.details)),
  ];
}

/** Exponential backoff after `failures` consecutive transient failures: 1 s, 2 s, 4 s ... capped. */
export function retryDelayMs(failures: number): number {
  return Math.min(RETRY_MAX_MS, RETRY_BASE_MS * 2 ** Math.max(0, failures - 1));
}

export interface BufferedAuditWriterOptions {
  db: Pick<Db, 'query'>;
  logger: Logger;
  metrics: Pick<Metrics, 'auditQueueDepth' | 'auditEventsTotal' | 'auditFlushDuration'>;
  clock: Clock;
  instanceId: string;
  /** AUDIT_QUEUE_MAX */
  queueMax: number;
  /** AUDIT_BATCH_SIZE */
  batchSize: number;
  /** AUDIT_FLUSH_INTERVAL_MS */
  flushIntervalMs: number;
}

export class BufferedAuditWriter implements AuditLogger, Lifecycle {
  readonly #options: BufferedAuditWriterOptions;
  readonly #logger: Logger;
  #queue: NormalizedAuditEvent[] = [];
  /** Events taken off the queue by the write in progress (they still count against the bound). */
  #inFlight = 0;
  #draining: Promise<void> | undefined;
  #consecutiveFailures = 0;
  /** No automatic attempt before this time (transient backoff). */
  #retryAt = 0;
  #intervalTimer: NodeJS.Timeout | undefined;
  #retryTimer: NodeJS.Timeout | undefined;
  #lastDropLogAt = Number.NEGATIVE_INFINITY;
  #lastFailureLogAt = Number.NEGATIVE_INFINITY;
  #closing: Promise<void> | undefined;
  #closed = false;

  constructor(options: BufferedAuditWriterOptions) {
    this.#options = options;
    this.#logger = options.logger.child({ component: 'audit' });
  }

  start(): void {
    if (this.#intervalTimer !== undefined || this.#closing !== undefined) return;
    this.#intervalTimer = setInterval(() => {
      this.#kick();
    }, this.#options.flushIntervalMs);
    this.#intervalTimer.unref();
  }

  record(event: AuditEvent): void {
    try {
      const normalized = normalizeAuditEvent(event, this.#options.clock.now());
      // The log line is the second trail: it exists even when the row is later dropped or rejected.
      this.#logger.info({ audit: true, ...normalized }, `audit ${normalized.action} ${normalized.outcome}`);
      if (this.#closed || this.#size() >= this.#options.queueMax) {
        this.#drop(normalized);
        return;
      }
      this.#queue.push(normalized);
      this.#updateDepth();
      if (this.#queue.length >= this.#options.batchSize) this.#kick();
    } catch (error) {
      // record() must never throw into the request path.
      this.#logger.error({ err: error, action: event.action }, 'audit event could not be recorded');
    }
  }

  /** Writes everything queued now (ignoring a pending backoff). Never throws; unwritten events stay queued. */
  async flush(): Promise<void> {
    if (this.#draining !== undefined) await this.#draining;
    if (this.#queue.length === 0) return;
    await this.#drain();
  }

  /** Events waiting to be written, the batch in flight included. */
  get depth(): number {
    return this.#size();
  }

  close(): Promise<void> {
    this.#closing ??= this.#shutdown();
    return this.#closing;
  }

  async #shutdown(): Promise<void> {
    this.#clearTimers();
    // One bounded flush: a transient failure inside it is not retried (the retry timer is gone by now).
    await withTimeout(this.flush(), SHUTDOWN_FLUSH_BUDGET_MS).catch(() => undefined);
    this.#closed = true;
    if (this.#queue.length > 0) {
      this.#lose(
        this.#queue.length,
        'audit events could not be written before shutdown (their log lines remain)',
      );
    }
    this.#queue = [];
    this.#updateDepth();
  }

  #size(): number {
    return this.#queue.length + this.#inFlight;
  }

  /** Starts a background drain unless one runs, the queue is empty or a backoff is pending. */
  #kick(): void {
    if (this.#draining !== undefined || this.#queue.length === 0) return;
    if (this.#options.clock.now() < this.#retryAt) return;
    runDetached(this.#drain(), this.#logger, 'audit flush');
  }

  #drain(): Promise<void> {
    this.#draining ??= this.#drainQueue().finally(() => {
      this.#draining = undefined;
    });
    return this.#draining;
  }

  async #drainQueue(): Promise<void> {
    while (this.#queue.length > 0) {
      const batch = this.#queue.splice(0, this.#options.batchSize);
      this.#inFlight = batch.length;
      let unwritten: NormalizedAuditEvent[];
      try {
        unwritten = await this.#writeBatch(batch);
      } finally {
        this.#inFlight = 0;
      }
      if (unwritten.length === 0) {
        this.#consecutiveFailures = 0;
        this.#retryAt = 0;
        this.#updateDepth();
        continue;
      }
      if (this.#closed) {
        // Nothing retries after shutdown: the pool may already be gone.
        this.#lose(unwritten.length, 'audit batch still in flight at shutdown failed; its events are lost');
      } else {
        this.#queue.unshift(...unwritten);
        this.#scheduleRetry();
      }
      this.#updateDepth();
      return;
    }
  }

  /** Writes one batch; returns the rows to requeue (empty once every row was written or rejected). */
  async #writeBatch(batch: NormalizedAuditEvent[]): Promise<NormalizedAuditEvent[]> {
    const error = await this.#tryInsert(batch);
    if (error === null) return [];
    if (isTransientAuditError(error)) {
      this.#logFailure(error, batch.length);
      return batch;
    }
    // Not transient: some rows are at fault. One INSERT per row keeps the good ones (section 10.4).
    for (const [index, event] of batch.entries()) {
      // After shutdown the pool may be gone: no further statements, the caller counts the rest as failed.
      if (this.#closed) return batch.slice(index);
      const rowError = await this.#tryInsert([event]);
      if (rowError === null) continue;
      if (isTransientAuditError(rowError)) {
        this.#logFailure(rowError, batch.length - index);
        return batch.slice(index);
      }
      this.#reject(event, rowError);
    }
    return [];
  }

  /** One INSERT; resolves the error instead of throwing (null = written). */
  async #tryInsert(events: readonly NormalizedAuditEvent[]): Promise<unknown> {
    const { db, metrics, instanceId } = this.#options;
    const stopTimer = metrics.auditFlushDuration.startTimer();
    try {
      await db.query(INSERT_AUDIT_BATCH, toInsertParams(events, instanceId));
      metrics.auditEventsTotal.inc({ result: 'written' }, events.length);
      return null;
    } catch (error) {
      return error ?? new Error('audit insert failed');
    } finally {
      stopTimer();
    }
  }

  #reject(event: NormalizedAuditEvent, error: unknown): void {
    this.#options.metrics.auditEventsTotal.inc({ result: 'rejected' });
    const constraint =
      typeof error === 'object' && error !== null && 'constraint' in error ? error.constraint : undefined;
    this.#logger.error(
      { err: error, action: event.action, outcome: event.outcome, code: pgErrorCode(error), constraint },
      'audit event rejected by PostgreSQL; the poison row was dropped',
    );
  }

  #lose(events: number, message: string): void {
    this.#options.metrics.auditEventsTotal.inc({ result: 'failed' }, events);
    this.#logger.error({ lost: events }, message);
  }

  #drop(event: NormalizedAuditEvent): void {
    this.#options.metrics.auditEventsTotal.inc({ result: 'dropped' });
    const now = this.#options.clock.now();
    if (now - this.#lastDropLogAt < LOG_INTERVAL_MS) return;
    this.#lastDropLogAt = now;
    this.#logger.error(
      { action: event.action, queueMax: this.#options.queueMax, closed: this.#closed },
      this.#closed ? 'audit writer closed: event dropped' : 'audit queue full: newest event dropped',
    );
  }

  #logFailure(error: unknown, events: number): void {
    const now = this.#options.clock.now();
    if (now - this.#lastFailureLogAt < LOG_INTERVAL_MS) return;
    this.#lastFailureLogAt = now;
    this.#logger.warn(
      { err: error, events, retryInMs: retryDelayMs(this.#consecutiveFailures + 1) },
      'audit write failed transiently; events stay queued',
    );
  }

  #scheduleRetry(): void {
    this.#consecutiveFailures += 1;
    const delay = retryDelayMs(this.#consecutiveFailures);
    this.#retryAt = this.#options.clock.now() + delay;
    if (this.#retryTimer !== undefined) clearTimeout(this.#retryTimer);
    if (this.#closing !== undefined) return; // shutdown flushes once; nothing retries after it
    this.#retryTimer = setTimeout(() => {
      this.#retryTimer = undefined;
      this.#kick();
    }, delay);
    this.#retryTimer.unref();
  }

  #clearTimers(): void {
    if (this.#intervalTimer !== undefined) clearInterval(this.#intervalTimer);
    if (this.#retryTimer !== undefined) clearTimeout(this.#retryTimer);
    this.#intervalTimer = undefined;
    this.#retryTimer = undefined;
  }

  #updateDepth(): void {
    this.#options.metrics.auditQueueDepth.set(this.#size());
  }
}
