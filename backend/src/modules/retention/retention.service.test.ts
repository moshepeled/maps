import { pino } from 'pino';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { loadConfig } from '../../config/env.js';
import type { AuditEvent } from '../../infra/audit/types.js';
import type { DbTx, TransactionOptions } from '../../infra/db/types.js';
import { createMetrics } from '../../infra/metrics/metrics.js';
import { RetentionJob } from './retention.job.js';
import type { PurgeCounts, RetentionLastRun, RetentionRepository } from './retention.repository.js';
import { RetentionService } from './retention.service.js';
import type { RetentionRunResult } from './retention.service.js';
import type { LockSession } from './run-lock.js';

const CONFIG = loadConfig({
  DATABASE_URL: 'postgres://u:p@127.0.0.1:1/x',
  REDIS_URL: 'redis://127.0.0.1:1',
  JWT_SECRET: 'x'.repeat(40),
  METRICS_ENABLED: 'false',
});

/** Rows waiting to be purged per entity; each purge call deletes min(batch, remaining). */
interface FakeOptions {
  locked?: boolean;
  failOn?: keyof PurgeCounts;
  /** recordLastRun rejects (e.g. the database went away after the last batch). */
  recordFails?: boolean;
  /** The dedicated lock connection cannot be opened. */
  connectFails?: boolean;
}

function fakeRepository(pending: PurgeCounts, options: FakeOptions = {}) {
  const batches: { entity: keyof PurgeCounts; size: number; deleted: number }[] = [];
  const lastRuns: RetentionLastRun[] = [];
  /** The order of the lock-session and run-record calls (the record must be written while the lock is held). */
  const calls: string[] = [];
  const session: LockSession = {
    tryLock: () => {
      calls.push('tryLock');
      return Promise.resolve(options.locked ?? true);
    },
    unlock: () => {
      calls.push('unlock');
      return Promise.resolve(true);
    },
    release: () => {
      calls.push('release');
    },
  };
  const repository: RetentionRepository = {
    purgeBatch: (_tx: DbTx, entity, _days, size) => {
      if (options.failOn === entity)
        return Promise.reject(Object.assign(new Error('boom'), { code: '57014' }));
      const deleted = Math.min(size, pending[entity]);
      pending[entity] -= deleted;
      batches.push({ entity, size, deleted });
      return Promise.resolve(deleted);
    },
    recordLastRun: (run) => {
      calls.push('recordLastRun');
      if (options.recordFails === true) return Promise.reject(new Error('connection terminated'));
      lastRuns.push(run);
      return Promise.resolve();
    },
    connectLockSession: () =>
      options.connectFails === true
        ? Promise.reject(Object.assign(new Error('connect failed'), { code: 'ECONNREFUSED' }))
        : Promise.resolve(session),
  };
  return { repository, batches, lastRuns, calls };
}

function setup(pending: PurgeCounts, options: FakeOptions & { batchSize?: number } = {}) {
  const { repository, batches, lastRuns, calls } = fakeRepository(pending, options);
  const transactions: (TransactionOptions | undefined)[] = [];
  const events: AuditEvent[] = [];
  const metrics = createMetrics(CONFIG, 'unit');
  const service = new RetentionService({
    db: {
      withTransaction: <T>(fn: (tx: DbTx) => Promise<T>, opts?: TransactionOptions) => {
        transactions.push(opts);
        return fn({ query: () => Promise.resolve([]) });
      },
    },
    repository,
    audit: { record: (event) => events.push(event), flush: () => Promise.resolve() },
    metrics,
    logger: pino({ level: 'silent' }),
    clock: { now: () => Date.now() },
    settings: {
      AREA_PURGE_AFTER_DAYS: 30,
      AUDIT_RETENTION_DAYS: 90,
      SESSION_PURGE_AFTER_DAYS: 7,
      RETENTION_BATCH_SIZE: options.batchSize ?? 1000,
      RETENTION_STATEMENT_TIMEOUT_MS: 60_000,
    },
  });
  const purgedMetric = async (): Promise<Record<string, number>> =>
    Object.fromEntries(
      (await metrics.retentionPurgedTotal.get()).values.map((value) => [
        String(value.labels.entity),
        value.value,
      ]),
    );
  return { service, batches, lastRuns, calls, transactions, events, purgedMetric };
}

describe('RetentionService.runOnce (section 5.6)', () => {
  it('purges areas in batches of <= 200 and audit/sessions in RETENTION_BATCH_SIZE, until a short batch', async () => {
    const { service, batches } = setup({ areas: 450, audit: 2500, sessions: 3 });
    const result = await service.runOnce();
    expect(result).toMatchObject({ status: 'completed', purged: { areas: 450, audit: 2500, sessions: 3 } });
    expect(batches).toEqual([
      { entity: 'areas', size: 200, deleted: 200 },
      { entity: 'areas', size: 200, deleted: 200 },
      { entity: 'areas', size: 200, deleted: 50 },
      { entity: 'audit', size: 1000, deleted: 1000 },
      { entity: 'audit', size: 1000, deleted: 1000 },
      { entity: 'audit', size: 1000, deleted: 500 },
      { entity: 'sessions', size: 1000, deleted: 3 },
    ]);
  });

  it('runs every batch in its own transaction with timeoutMs = RETENTION_STATEMENT_TIMEOUT_MS', async () => {
    const { service, transactions } = setup({ areas: 200, audit: 0, sessions: 0 });
    await service.runOnce();
    // areas: a full batch then an empty one; audit and sessions: one empty batch each.
    expect(transactions).toEqual([
      { timeoutMs: 60_000 },
      { timeoutMs: 60_000 },
      { timeoutMs: 60_000 },
      { timeoutMs: 60_000 },
    ]);
  });

  it('records retention_last_run, the retention.run audit event and the purge counters', async () => {
    const { service, lastRuns, events, purgedMetric } = setup({ areas: 2, audit: 3, sessions: 4 });
    const result = await service.runOnce();
    expect(lastRuns).toHaveLength(1);
    expect(lastRuns[0]).toEqual({
      at: expect.any(String) as unknown,
      purged: { areas: 2, audit: 3, sessions: 4 },
      durationMs: (result as { durationMs: number }).durationMs,
      status: 'completed',
    });
    expect(Date.parse(lastRuns[0]?.at ?? '')).not.toBeNaN();
    expect(events).toEqual([
      {
        action: 'retention.run',
        outcome: 'success',
        actorId: null,
        targetType: 'system',
        targetId: null,
        details: {
          purged: { areas: 2, audit: 3, sessions: 4 },
          durationMs: (result as { durationMs: number }).durationMs,
        },
      },
    ]);
    expect(await purgedMetric()).toEqual({ areas: 2, audit: 3, sessions: 4 });
  });

  it('is skipped (no purge, no audit) when another instance holds the lock', async () => {
    const { service, batches, events, lastRuns } = setup(
      { areas: 5, audit: 5, sessions: 5 },
      { locked: false },
    );
    expect(await service.runOnce()).toEqual({ status: 'skipped' });
    expect(batches).toEqual([]);
    expect(events).toEqual([]);
    expect(lastRuns).toEqual([]);
  });

  it('never throws: a failed batch audits a failure and records the progress so far', async () => {
    const { service, events, lastRuns, purgedMetric } = setup(
      { areas: 3, audit: 5, sessions: 0 },
      { failOn: 'audit' },
    );
    const result = await service.runOnce();
    expect(result.status).toBe('failed');
    expect(lastRuns).toEqual([
      {
        at: expect.any(String) as unknown,
        purged: { areas: 3, audit: 0, sessions: 0 },
        durationMs: expect.any(Number) as unknown,
        status: 'failed',
        reason: '57014',
      },
    ]);
    expect(events[0]).toMatchObject({
      action: 'retention.run',
      outcome: 'failure',
      details: { purged: { areas: 3, audit: 0, sessions: 0 }, reason: '57014' },
    });
    expect(await purgedMetric()).toEqual({ areas: 3 });
  });

  it('stops between batches once a stop is requested', async () => {
    const { service, batches, events, lastRuns } = setup({ areas: 1000, audit: 0, sessions: 0 });
    service.requestStop();
    const result = await service.runOnce();
    expect(result.status).toBe('stopped');
    expect(batches).toEqual([]);
    expect(events[0]?.details).toMatchObject({ reason: 'stopped' });
    expect(lastRuns).toMatchObject([{ status: 'stopped', purged: { areas: 0, audit: 0, sessions: 0 } }]);
    expect(lastRuns[0]).not.toHaveProperty('reason');
  });

  // Recorded after the unlock, an older run's record could overwrite the record of a newer run on another instance.
  it.each([
    ['a completed run', {}, 'completed'],
    ['a failed run', { failOn: 'audit' }, 'failed'],
    ['a stopped run', { stop: true }, 'stopped'],
  ] as const)(
    '%s writes retention_last_run while it still holds the lock',
    async (_name, scenario, status) => {
      const { service, calls, lastRuns } = setup(
        { areas: 3, audit: 2, sessions: 1 },
        'failOn' in scenario ? { failOn: scenario.failOn } : {},
      );
      if ('stop' in scenario) service.requestStop();
      await service.runOnce();
      expect(lastRuns).toMatchObject([{ status }]);
      expect(calls).toEqual(['tryLock', 'recordLastRun', 'unlock', 'release']);
    },
  );

  it('a run record that cannot be written does not turn a completed run into a failure', async () => {
    const { service, events } = setup({ areas: 1, audit: 0, sessions: 0 }, { recordFails: true });
    const result = await service.runOnce();
    expect(result).toMatchObject({ status: 'completed', purged: { areas: 1, audit: 0, sessions: 0 } });
    expect(events).toMatchObject([{ action: 'retention.run', outcome: 'success' }]);
  });

  it('records nothing in retention_last_run when the lock was never held (connect failed)', async () => {
    const { service, events, lastRuns } = setup({ areas: 1, audit: 0, sessions: 0 }, { connectFails: true });
    expect((await service.runOnce()).status).toBe('failed');
    expect(lastRuns).toEqual([]);
    expect(events).toMatchObject([{ outcome: 'failure', details: { reason: 'ECONNREFUSED' } }]);
  });
});

describe('RetentionJob (timer)', () => {
  beforeEach(() => {
    vi.useFakeTimers({ now: 0 });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  function runner() {
    const runs: number[] = [];
    let stops = 0;
    return {
      runs,
      stops: () => stops,
      runner: {
        runOnce: (): Promise<RetentionRunResult> => {
          runs.push(Date.now());
          return Promise.resolve({ status: 'skipped' });
        },
        requestStop: () => {
          stops += 1;
        },
      },
    };
  }

  it('runs after the initial delay, then every interval +/- 10 % (seeded), until stopped', async () => {
    const fake = runner();
    const job = new RetentionJob({
      runner: fake.runner,
      initialDelayMs: 60_000,
      intervalMs: 3_600_000,
      logger: pino({ level: 'silent' }),
      random: () => 0,
    });
    job.start();
    await vi.advanceTimersByTimeAsync(59_999);
    expect(fake.runs).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(fake.runs).toEqual([60_000]);
    await vi.advanceTimersByTimeAsync(3_240_000);
    expect(fake.runs).toEqual([60_000, 3_300_000]);
    await job.stop();
    await job.stop();
    expect(fake.stops()).toBe(2);
    await vi.advanceTimersByTimeAsync(10_000_000);
    expect(fake.runs).toHaveLength(2);
  });

  it('a random draw of 1 puts the next run at 1.1 x the interval (the top of the jitter band)', async () => {
    const fake = runner();
    const job = new RetentionJob({
      runner: fake.runner,
      initialDelayMs: 0,
      intervalMs: 1000,
      logger: pino({ level: 'silent' }),
      random: () => 1,
    });
    job.start();
    await vi.advanceTimersByTimeAsync(1099);
    expect(fake.runs).toEqual([0]);
    await vi.advanceTimersByTimeAsync(1);
    expect(fake.runs).toEqual([0, 1100]);
    await job.stop();
  });
});
