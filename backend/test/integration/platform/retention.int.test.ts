/**
 * Retention (SPEC section 5.6, section 10.5) against the run's PostgreSQL:
 * - soft-deleted areas older than AREA_PURGE_AFTER_DAYS are hard-deleted with their versions, in batches of at most 200
 *   (RETENTION_BATCH_SIZE is set above 200 here, so the cap is what bounds them); audit rows and dead sessions follow in
 *   batches of RETENTION_BATCH_SIZE; younger rows survive;
 * - every batch runs in its own `withTransaction(fn, { timeoutMs: RETENTION_STATEMENT_TIMEOUT_MS })` (spied), and the
 *   server-side statement_timeout inside it is the retention value, not the pool's default;
 * - the change-feed watermark rises to the newest purged change, and because latestChangeSeq is
 *   GREATEST(max(change_seq), watermark), a client that read `asOfChangeSeq` after the purge can follow the feed (200),
 *   while one asking from before the watermark gets 410;
 * - `retention_last_run`, the `retention.run` audit event and `snapland_retention_purged_total` record each run;
 * - two concurrent runners: exactly one works, the other is skipped (pg_try_advisory_lock(7210002));
 * - the module's timer runs the job when RETENTION_ENABLED (the harness default is off).
 */
import { randomUUID } from 'node:crypto';

import { AreaListResponseSchema, ChangeFeedResponseSchema } from '@snapland/shared';
import type { QueryResultRow } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { Container } from '../../../src/container.js';
import type { InMemoryAuditLogger } from '../../../src/infra/audit/in-memory.js';
import { sql } from '../../../src/infra/db/types.js';
import type { Db, DbTx, NamedSql, TransactionOptions } from '../../../src/infra/db/types.js';
import { createAreasModule } from '../../../src/modules/areas/index.js';
import { createRetentionModule, createRetentionService } from '../../../src/modules/retention/index.js';
import type { RetentionRunResult } from '../../../src/modules/retention/index.js';
import { MAX_AREA_BATCH_SIZE } from '../../../src/modules/retention/retention.service.js';
import { RETENTION_LOCK_KEY } from '../../../src/modules/retention/run-lock.js';
import { createMemoryAudit } from '../../helpers/audit.js';
import { createTestApp } from '../../helpers/test-app.js';
import type { TestApp } from '../../helpers/test-app.js';
import { bearer, createUser } from '../../helpers/users.js';
import type { TestUser } from '../../helpers/users.js';
import { waitFor } from '../../helpers/wait-for.js';
import { metricValue } from './support/metrics.js';
import { RetentionFixtures } from './support/retention-fixtures.js';

const TAG = `retention-it-${randomUUID().slice(0, 8)}`;
/** Above the 200-area cap, so area batches are bounded by the cap and audit/session batches by this value. */
const BATCH_SIZE = 250;
/** Distinct from the pool's 5 s default, so the spy can tell which timeout a batch ran under. */
const STATEMENT_TIMEOUT_MS = 45_000;
const DOOMED_AREAS = 450;
const OLD_AUDIT_ROWS = 300;
const SESSION_GROUPS = {
  expiredOld: { label: 'expired-old', n: 30, kind: 'expired', daysAgo: 8 },
  revokedOld: { label: 'revoked-old', n: 10, kind: 'revoked', daysAgo: 8 },
  expiredYoung: { label: 'expired-young', n: 5, kind: 'expired', daysAgo: 2 },
  revokedYoung: { label: 'revoked-young', n: 5, kind: 'revoked', daysAgo: 2 },
} as const;
/** A bbox around the fixture grid (~ 1,900 px wide at z17, where reads bypass the cache). */
const FIXTURE_BBOX = '34.69,31.89,34.71,31.91';

const CURRENT_STATEMENT_TIMEOUT = sql(
  'platformRetention.currentStatementTimeout',
  "SELECT current_setting('statement_timeout') AS value",
);
/** Session-level advisory locks on the retention key held in this database (bigint keys: classid 0, objsubid 1). */
const RETENTION_LOCK_HOLDERS = sql(
  'platformRetention.lockHolders',
  `SELECT count(*)::int AS n FROM pg_locks
   WHERE locktype = 'advisory' AND database = (SELECT oid FROM pg_database WHERE datname = current_database())
     AND classid = 0 AND objid = $1::bigint AND objsubid = 1 AND granted`,
);

interface SpiedTransaction {
  opts: TransactionOptions | undefined;
  /** `current_setting('statement_timeout')` inside the transaction, before the batch ran. */
  statementTimeout: string | undefined;
  /** What the batch returned (the rows it deleted). */
  result: unknown;
}

/**
 * `db` with `withTransaction` observed: records the options, the server timeout in force inside the transaction and
 * the batch's result. `beforeEach` (optional) runs before every transaction - the concurrency test parks a runner
 * there while it holds the advisory lock.
 */
function spyDb(db: Db, transactions: SpiedTransaction[], beforeEach?: () => Promise<void>): Db {
  return {
    pool: db.pool,
    query: <R extends QueryResultRow>(stmt: NamedSql, params?: readonly unknown[]) =>
      db.query<R>(stmt, params),
    ping: (timeoutMs) => db.ping(timeoutMs),
    async withTransaction<T>(fn: (tx: DbTx) => Promise<T>, opts?: TransactionOptions): Promise<T> {
      await beforeEach?.();
      const record: SpiedTransaction = { opts, statementTimeout: undefined, result: undefined };
      transactions.push(record);
      const result = await db.withTransaction(async (tx) => {
        const [row] = await tx.query<{ value: string }>(CURRENT_STATEMENT_TIMEOUT);
        record.statementTimeout = row?.value;
        return fn(tx);
      }, opts);
      record.result = result;
      return result;
    },
  };
}

function withDb(container: Container, db: Db): Container {
  return { ...container, db };
}

/**
 * Removes one entity's batches from the front of the recorded results: every batch up to and including the first
 * that deleted fewer rows than `batchSize` (the service's stop rule).
 */
function takeBatches(results: number[], batchSize: number): number[] {
  const taken: number[] = [];
  for (let next = results.shift(); next !== undefined; next = results.shift()) {
    taken.push(next);
    if (next < batchSize) break;
  }
  return taken;
}

const sum = (values: readonly number[]): number => values.reduce((total, value) => total + value, 0);

let testApp: TestApp;
let audit: InMemoryAuditLogger;
let owner: TestUser;
let fixtures: RetentionFixtures;
let keptAreaIds: string[];
let doomedAreaIds: string[];

beforeAll(async () => {
  audit = createMemoryAudit();
  testApp = await createTestApp({
    modules: [createAreasModule],
    config: { RETENTION_BATCH_SIZE: BATCH_SIZE, RETENTION_STATEMENT_TIMEOUT_MS: STATEMENT_TIMEOUT_MS },
    overrides: { audit },
  });
  owner = await createUser(testApp.container);
  fixtures = new RetentionFixtures(testApp.container, TAG);
  // Younger rows first: the purge-eligible areas then hold the newest change_seq values of the database, which is
  // the case the watermark rule exists for ("purging the latest changes").
  keptAreaIds = [
    ...(await fixtures.insertAreas(owner.id, 3, 10)),
    ...(await fixtures.insertAreas(owner.id, 1, null)),
  ];
  doomedAreaIds = await fixtures.insertAreas(owner.id, DOOMED_AREAS, 31);
  await fixtures.insertAudit(OLD_AUDIT_ROWS, 91);
  await fixtures.insertAudit(5, 80);
  for (const group of Object.values(SESSION_GROUPS)) {
    await fixtures.insertSessions(owner.id, group.label, group.n, group.kind, group.daysAgo);
  }
});

afterAll(async () => {
  await fixtures.cleanup(Object.values(SESSION_GROUPS).map((group) => group.label));
  await testApp.close();
});

describe('one retention run (section 5.6)', () => {
  const transactions: SpiedTransaction[] = [];
  let result: RetentionRunResult;
  let expectedWatermark: number;
  const purgedBefore = { areas: 0, audit: 0, sessions: 0 };

  beforeAll(async () => {
    const { metrics } = testApp.container;
    for (const entity of ['areas', 'audit', 'sessions'] as const) {
      purgedBefore[entity] = await metricValue(metrics.retentionPurgedTotal, { entity });
    }
    const watermarkBefore = Number(await fixtures.readState<number>('change_feed_purge_watermark'));
    expectedWatermark = Math.max(watermarkBefore, await fixtures.maxVersionSeq(doomedAreaIds));
    expect(expectedWatermark).toBeGreaterThan(await fixtures.maxVersionSeq(keptAreaIds));

    const service = createRetentionService(
      withDb(testApp.container, spyDb(testApp.container.db, transactions)),
    );
    result = await service.runOnce();
  });

  it('completes and purges at least the eligible fixtures of each entity', () => {
    expect(result.status).toBe('completed');
    if (result.status !== 'completed') return;
    expect(result.purged.areas).toBeGreaterThanOrEqual(DOOMED_AREAS);
    expect(result.purged.audit).toBeGreaterThanOrEqual(OLD_AUDIT_ROWS);
    expect(result.purged.sessions).toBeGreaterThanOrEqual(
      SESSION_GROUPS.expiredOld.n + SESSION_GROUPS.revokedOld.n,
    );
  });

  it('hard-deletes soft-deleted areas older than AREA_PURGE_AFTER_DAYS together with their versions', async () => {
    expect(await fixtures.countAreas(doomedAreaIds)).toBe(0);
    expect(await fixtures.countVersions(doomedAreaIds)).toBe(0);
    // 3 areas deleted 10 days ago (2 versions each) and 1 live area (1 version) are kept.
    expect(await fixtures.countAreas(keptAreaIds)).toBe(4);
    expect(await fixtures.countVersions(keptAreaIds)).toBe(7);
  });

  it('purges audit rows older than AUDIT_RETENTION_DAYS and dead sessions older than SESSION_PURGE_AFTER_DAYS', async () => {
    expect(await fixtures.countAudit()).toBe(5);
    expect(await fixtures.countSessions(SESSION_GROUPS.expiredOld.label)).toBe(0);
    expect(await fixtures.countSessions(SESSION_GROUPS.revokedOld.label)).toBe(0);
    expect(await fixtures.countSessions(SESSION_GROUPS.expiredYoung.label)).toBe(
      SESSION_GROUPS.expiredYoung.n,
    );
    expect(await fixtures.countSessions(SESSION_GROUPS.revokedYoung.label)).toBe(
      SESSION_GROUPS.revokedYoung.n,
    );
    expect(await testApp.container.sessions.getActive(owner.sessionId)).not.toBeNull();
  });

  it('purges areas in batches of at most 200, then audit and sessions in batches of RETENTION_BATCH_SIZE', () => {
    if (result.status !== 'completed') throw new Error('run did not complete');
    const results = transactions.map((transaction) => Number(transaction.result));
    const areaBatches = takeBatches(results, MAX_AREA_BATCH_SIZE);
    const auditBatches = takeBatches(results, BATCH_SIZE);
    const sessionBatches = takeBatches(results, BATCH_SIZE);

    // Order and totals: areas, then audit, then sessions - nothing else ran in a transaction.
    expect(results).toEqual([]);
    expect([sum(areaBatches), sum(auditBatches), sum(sessionBatches)]).toEqual([
      result.purged.areas,
      result.purged.audit,
      result.purged.sessions,
    ]);
    // 450 areas need at least three batches, each capped at 200 although RETENTION_BATCH_SIZE is 250.
    expect(areaBatches.length).toBeGreaterThanOrEqual(Math.ceil(DOOMED_AREAS / MAX_AREA_BATCH_SIZE));
    expect(Math.max(...areaBatches)).toBe(MAX_AREA_BATCH_SIZE);
    // 300 audit rows need at least two batches of RETENTION_BATCH_SIZE.
    expect(auditBatches.length).toBeGreaterThanOrEqual(2);
    expect(Math.max(...auditBatches)).toBe(BATCH_SIZE);
    expect(Math.max(...sessionBatches)).toBeLessThanOrEqual(BATCH_SIZE);
  });

  it('runs every batch in its own transaction under RETENTION_STATEMENT_TIMEOUT_MS (not the pool default)', () => {
    expect(transactions.length).toBeGreaterThanOrEqual(6);
    for (const transaction of transactions) {
      expect(transaction.opts).toMatchObject({ timeoutMs: STATEMENT_TIMEOUT_MS });
      expect(transaction.statementTimeout).toBe(`${STATEMENT_TIMEOUT_MS / 1000}s`);
    }
    expect(testApp.container.config.DB_STATEMENT_TIMEOUT_MS).not.toBe(STATEMENT_TIMEOUT_MS);
  });

  it('raises the watermark to the newest purged change; asOfChangeSeq >= watermark and the feed from it -> 200', async () => {
    const watermark = Number(await fixtures.readState<number>('change_feed_purge_watermark'));
    expect(watermark).toBe(expectedWatermark);

    const page = await testApp.app.inject({
      method: 'GET',
      url: `/api/v1/areas?bbox=${FIXTURE_BBOX}&zoom=17`,
      headers: bearer(owner),
    });
    expect(page.statusCode, page.body).toBe(200);
    const { asOfChangeSeq, items } = AreaListResponseSchema.parse(page.json());
    // The newest remaining change is older than the purged ones: only GREATEST(..., watermark) keeps asOf this high.
    expect(asOfChangeSeq).toBe(watermark);
    expect(items.map((item) => item.id)).toEqual(expect.arrayContaining([keptAreaIds[3]]));

    const feed = await testApp.app.inject({
      method: 'GET',
      url: `/api/v1/areas/changes?since=${asOfChangeSeq}`,
      headers: bearer(owner),
    });
    expect(feed.statusCode, feed.body).toBe(200);
    expect(ChangeFeedResponseSchema.parse(feed.json())).toMatchObject({
      items: [],
      hasMore: false,
      latestChangeSeq: watermark,
    });

    const expired = await testApp.app.inject({
      method: 'GET',
      url: `/api/v1/areas/changes?since=${watermark - 1}`,
      headers: bearer(owner),
    });
    expect(expired.statusCode).toBe(410);
    expect(expired.json<{ code: string; watermark: number }>()).toMatchObject({
      code: 'CHANGE_FEED_EXPIRED',
      watermark,
    });
  });

  it('records retention_last_run, the retention.run audit event and the purge counters', async () => {
    if (result.status !== 'completed') throw new Error('run did not complete');
    const { purged, durationMs } = result;
    expect(await fixtures.readState('retention_last_run')).toEqual({
      at: expect.any(String) as unknown,
      purged,
      durationMs,
      status: 'completed',
    });

    const events = audit.find((event) => event.action === 'retention.run');
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      outcome: 'success',
      actorId: null,
      targetType: 'system',
      details: { purged, durationMs },
    });

    const { metrics } = testApp.container;
    for (const entity of ['areas', 'audit', 'sessions'] as const) {
      expect(await metricValue(metrics.retentionPurgedTotal, { entity })).toBe(
        purgedBefore[entity] + purged[entity],
      );
    }
  });
});

describe('two concurrent runners (pg_try_advisory_lock(7210002))', () => {
  it('only one works: the other is skipped at once, and the lock is released afterwards', async () => {
    const { container } = testApp;
    const lockHolders = async (): Promise<number> =>
      (await container.db.query<{ n: number }>(RETENTION_LOCK_HOLDERS, [RETENTION_LOCK_KEY]))[0]?.n ?? 0;

    let signalEntered: () => void = () => undefined;
    const entered = new Promise<void>((resolve) => {
      signalEntered = resolve;
    });
    let openGate: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      openGate = resolve;
    });
    // The first runner parks before its first batch - i.e. while it holds the advisory lock.
    const first = createRetentionService(
      withDb(
        container,
        spyDb(container.db, [], async () => {
          signalEntered();
          await gate;
        }),
      ),
    );
    const second = createRetentionService(container);

    const firstRun = first.runOnce();
    await entered;
    expect(await lockHolders()).toBe(1);
    const auditsBefore = audit.find((event) => event.action === 'retention.run').length;

    expect(await second.runOnce()).toEqual({ status: 'skipped' });
    // A skipped run records nothing: it did no work.
    expect(audit.find((event) => event.action === 'retention.run')).toHaveLength(auditsBefore);

    openGate();
    expect((await firstRun).status).toBe('completed');
    expect(await lockHolders()).toBe(0);
    expect((await second.runOnce()).status).toBe('completed');
  });
});

describe('the retention module (timer)', () => {
  it('runs the job RETENTION_INITIAL_DELAY_MS after start when RETENTION_ENABLED, and stops cleanly', async () => {
    const moduleAudit = createMemoryAudit();
    const scheduled = await createTestApp({
      modules: [createRetentionModule],
      config: { RETENTION_ENABLED: true, RETENTION_INITIAL_DELAY_MS: 0, RETENTION_INTERVAL_MS: 3_600_000 },
      overrides: { audit: moduleAudit },
    });
    try {
      const [event] = await waitFor(
        () => {
          const events = moduleAudit.find((candidate) => candidate.action === 'retention.run');
          return events.length > 0 && events;
        },
        { timeoutMs: 10_000, description: 'retention.run audited by the scheduled job' },
      );
      expect(event).toMatchObject({ outcome: 'success', targetType: 'system' });
      const lastRun = await fixtures.readState<{ at: string }>('retention_last_run');
      expect(lastRun?.at).toEqual(expect.any(String));
    } finally {
      await scheduled.close();
    }
  });
});
