/**
 * Audit analytics (SPEC section 5.2, section 6.4, section 10.4): `GET /admin/audit-stats` returns the exact aggregates of seeded rows, and
 * every one of its four base-table statements is served by the BRIN index - with `SET LOCAL enable_seqscan = off`
 * and every index of migration 0006 in place, each plan contains `audit_logs_occurred_at_brin`. No DDL is involved.
 */
import { randomUUID } from 'node:crypto';

import type pg from 'pg';

import { AuditStatsResponseSchema } from '@snapland/shared';
import type { AuditStatsResponse } from '@snapland/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { Container } from '../../../src/container.js';
import { sql } from '../../../src/infra/db/types.js';
import type { NamedSql } from '../../../src/infra/db/types.js';
import { AUDIT_STATS_SQL } from '../../../src/modules/admin/admin.repository.js';
import { createAdminModule } from '../../../src/modules/admin/index.js';
import { createMemoryAudit } from '../../helpers/audit.js';
import { createTestApp } from '../../helpers/test-app.js';
import type { TestApp } from '../../helpers/test-app.js';
import { bearer, createUser } from '../../helpers/users.js';
import type { TestUser } from '../../helpers/users.js';
import { deleteAuditRows, insertAuditRows } from './support/audit-fixtures.js';
import type { AuditFixtureRow } from './support/audit-fixtures.js';

const DAY_MS = 24 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;
const FIXTURE_INSTANCE = `analytics-it-${randomUUID().slice(0, 8)}`;
/** A 3-day window 40 days back (UTC midnight): no other test writes rows there, retention (90 d) keeps them. */
const base = new Date(Math.floor((Date.now() - 40 * DAY_MS) / DAY_MS) * DAY_MS);
const windowEnd = new Date(base.getTime() + 3 * DAY_MS);

/**
 * The BRIN proof block (section 5.2). Which index the planner picks for a time window is a question of volume and physical
 * correlation: on a small or poorly correlated table a full scan of `audit_logs_action_idx` (whose non-leading key is
 * `occurred_at`) is legitimately cheaper than the BRIN. So the proof runs on a production-like shape: PROOF_ROWS rows
 * spread over 48 days and inserted in time order AFTER every other row of the run, i.e. an append-only, time-correlated
 * tail like the real audit trail. It lies in the future because only there can it be both the newest data and
 * physically last, whatever earlier test files wrote. The proof window is its last 3 days. Measured on PostgreSQL 17:
 * with 600 to 20,000 other rows in the table the BRIN plan costs about half the full btree scan.
 */
const PROOF_ROWS = 20_000;
const proofWindowStart = new Date(Math.floor((Date.now() + 400 * DAY_MS) / DAY_MS) * DAY_MS);
const proofWindowEnd = new Date(proofWindowStart.getTime() + 3 * DAY_MS);
const proofBlockStart = new Date(proofWindowStart.getTime() - 45 * DAY_MS);

/** One statement, rows in time order (generate_series order is insertion order). */
const INSERT_PROOF_BLOCK = sql(
  'platformAnalytics.insertProofBlock',
  `INSERT INTO audit_logs (occurred_at, action, outcome, target_type, target_id, instance_id)
   SELECT $1::timestamptz + ($2::timestamptz - $1::timestamptz) * g / $3::int,
          (ARRAY['area.create', 'area.update', 'area.conflict', 'ratelimit.hit', 'auth.login'])[1 + g % 5],
          'success', 'area', 'brin-proof', $4
   FROM generate_series(0, $3::int - 1) AS g`,
);

/**
 * The view form of section 5.2 (`WHERE <date_trunc bucket> >= $1`): the negative control. It must NOT reach the BRIN under the
 * same conditions, otherwise the assertion above could not tell a sargable statement from a non-sargable one.
 */
const VIEW_SHAPED_ACTIONS_HOURLY = `SELECT hour, action, outcome, events, actors
   FROM audit_actions_hourly
   WHERE hour >= $1 AND hour < $2`;

const LIST_AUDIT_INDEXES = sql(
  'platformAnalytics.listAuditIndexes',
  "SELECT indexname FROM pg_indexes WHERE schemaname = current_schema() AND tablename = 'audit_logs'",
);

let testApp: TestApp;
let admin: TestUser;
let editorA: TestUser;
let editorB: TestUser;

function at(dayOffset: number, hour: number, minute: number): Date {
  return new Date(base.getTime() + dayOffset * DAY_MS + hour * HOUR_MS + minute * 60_000);
}

function iso(dayOffset: number, hour = 0): string {
  return new Date(base.getTime() + dayOffset * DAY_MS + hour * HOUR_MS).toISOString();
}

function seedRows(a: string, b: string): AuditFixtureRow[] {
  const area = { targetType: 'area', targetId: 'fixture' };
  return [
    // Day 0, 10:00 - three successful creates and one failed create by A.
    { at: at(0, 10, 1), action: 'area.create', outcome: 'success', actorId: a, ...area },
    { at: at(0, 10, 2), action: 'area.create', outcome: 'success', actorId: a, ...area },
    { at: at(0, 10, 3), action: 'area.create', outcome: 'success', actorId: a, ...area },
    {
      at: at(0, 10, 4),
      action: 'area.create',
      outcome: 'failure',
      actorId: a,
      ...area,
      details: { code: 'X' },
    },
    // Day 0, 11:00 - B: one merged update, one plain update, one conflict.
    {
      at: at(0, 11, 5),
      action: 'area.update',
      outcome: 'success',
      actorId: b,
      ...area,
      details: { merged: true },
    },
    {
      at: at(0, 11, 6),
      action: 'area.update',
      outcome: 'success',
      actorId: b,
      ...area,
      details: { merged: false },
    },
    { at: at(0, 11, 7), action: 'area.conflict', outcome: 'failure', actorId: b, ...area },
    // Day 0, 12:00 - rate-limit hits: a coalesced row (count 5) and a single anonymous hit (no count -> 1).
    {
      at: at(0, 12, 0),
      action: 'ratelimit.hit',
      outcome: 'denied',
      actorId: a,
      details: { scope: 'draw', count: 5 },
    },
    {
      at: at(0, 12, 30),
      action: 'ratelimit.hit',
      outcome: 'denied',
      actorId: null,
      details: { scope: 'api' },
    },
    // Day 1, 09:00 - a delete by A, a restore by B, an update by A, a login, a coalesced draw hit by B.
    { at: at(1, 9, 1), action: 'area.delete', outcome: 'success', actorId: a, ...area },
    { at: at(1, 9, 2), action: 'area.restore', outcome: 'success', actorId: b, ...area },
    {
      at: at(1, 9, 3),
      action: 'area.update',
      outcome: 'success',
      actorId: a,
      ...area,
      details: { merged: false },
    },
    { at: at(1, 9, 4), action: 'auth.login', outcome: 'success', actorId: null, targetType: 'user' },
    {
      at: at(1, 9, 5),
      action: 'ratelimit.hit',
      outcome: 'denied',
      actorId: b,
      details: { scope: 'draw', count: 2 },
    },
    // Outside the window on both sides: never counted.
    { at: new Date(base.getTime() - 1), action: 'area.create', outcome: 'success', actorId: a, ...area },
    { at: windowEnd, action: 'area.create', outcome: 'success', actorId: a, ...area },
  ];
}

beforeAll(async () => {
  testApp = await createTestApp({ modules: [createAdminModule], overrides: { audit: createMemoryAudit() } });
  admin = await createUser(testApp.container, { role: 'admin' });
  editorA = await createUser(testApp.container, { displayName: 'Editor A' });
  editorB = await createUser(testApp.container, { displayName: 'Editor B' });
  await insertAuditRows(testApp.container, FIXTURE_INSTANCE, seedRows(editorA.id, editorB.id));
  await testApp.container.db.query(INSERT_PROOF_BLOCK, [
    proofBlockStart,
    proofWindowEnd,
    PROOF_ROWS,
    FIXTURE_INSTANCE,
  ]);
  // Fresh statistics (row count, histogram, correlation) instead of waiting for autovacuum's analyze.
  await withClient(testApp.container, async (client) => {
    await client.query('ANALYZE audit_logs');
  });
});

afterAll(async () => {
  await deleteAuditRows(testApp.container, FIXTURE_INSTANCE);
  await testApp.close();
});

async function stats(): Promise<AuditStatsResponse> {
  const response = await testApp.app.inject({
    method: 'GET',
    url: `/api/v1/admin/audit-stats?from=${base.toISOString()}&to=${windowEnd.toISOString()}`,
    headers: bearer(admin),
  });
  expect(response.statusCode).toBe(200);
  return AuditStatsResponseSchema.parse(response.json());
}

/** Order-independent comparison (collation-specific ORDER BY of text is not what is under test). */
function byKey<T>(rows: readonly T[]): T[] {
  return [...rows].sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
}

describe('GET /admin/audit-stats aggregates (section 10.4 analytics)', () => {
  it('echoes the window', async () => {
    const result = await stats();
    expect([result.from, result.to]).toEqual([base.toISOString(), windowEnd.toISOString()]);
  });

  it('counts actions per hour with distinct actors', async () => {
    expect(byKey((await stats()).actionsByHour)).toEqual(
      byKey([
        { hour: iso(0, 10), action: 'area.create', outcome: 'success', events: 3, actors: 1 },
        { hour: iso(0, 10), action: 'area.create', outcome: 'failure', events: 1, actors: 1 },
        { hour: iso(0, 11), action: 'area.update', outcome: 'success', events: 2, actors: 1 },
        { hour: iso(0, 11), action: 'area.conflict', outcome: 'failure', events: 1, actors: 1 },
        { hour: iso(0, 12), action: 'ratelimit.hit', outcome: 'denied', events: 2, actors: 1 },
        { hour: iso(1, 9), action: 'area.delete', outcome: 'success', events: 1, actors: 1 },
        { hour: iso(1, 9), action: 'area.restore', outcome: 'success', events: 1, actors: 1 },
        { hour: iso(1, 9), action: 'area.update', outcome: 'success', events: 1, actors: 1 },
        { hour: iso(1, 9), action: 'auth.login', outcome: 'success', events: 1, actors: 0 },
        { hour: iso(1, 9), action: 'ratelimit.hit', outcome: 'denied', events: 1, actors: 1 },
      ]),
    );
  });

  it('ranks the top editors by successful area actions, with their display names', async () => {
    expect((await stats()).topEditors).toEqual([
      { actorId: editorA.id, displayName: 'Editor A', creates: 3, updates: 1, deletesRestores: 1 },
      { actorId: editorB.id, displayName: 'Editor B', creates: 0, updates: 2, deletesRestores: 1 },
    ]);
  });

  it('reports the daily conflict / merge rate', async () => {
    expect((await stats()).conflictRate).toEqual([
      { day: iso(0), updates: 2, merged: 1, conflicts: 1, rate: 1 / 3 },
      { day: iso(1), updates: 1, merged: 0, conflicts: 0, rate: 0 },
    ]);
  });

  it('sums coalesced rate-limit hits per day and scope (a row without count is one hit)', async () => {
    expect(byKey((await stats()).rateLimitHits)).toEqual(
      byKey([
        { day: iso(0), scope: 'api', hits: 1 },
        { day: iso(0), scope: 'draw', hits: 5 },
        { day: iso(1), scope: 'draw', hits: 2 },
      ]),
    );
  });
});

/** Runs `task` on a dedicated pooled client: raw SQL here must not go through the named-statement cache. */
async function withClient<T>(container: Container, task: (client: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await container.db.pool.connect();
  let releaseError: Error | undefined;
  try {
    return await task(client);
  } catch (error) {
    // A connection whose transaction state is unknown is destroyed instead of returned to the pool.
    releaseError = error instanceof Error ? error : new Error(String(error));
    throw error;
  } finally {
    client.release(releaseError);
  }
}

/** EXPLAIN of `statementText` with `SET LOCAL enable_seqscan = off`, in a transaction that is always rolled back. */
async function explainWithoutSeqScan(
  container: Container,
  statementText: string,
  params: readonly unknown[],
): Promise<string> {
  return withClient(container, async (client) => {
    await client.query('BEGIN');
    try {
      await client.query("SELECT set_config('enable_seqscan', 'off', true)");
      const result = await client.query<{ 'QUERY PLAN': string }>(`EXPLAIN ${statementText}`, [...params]);
      return result.rows.map((row) => row['QUERY PLAN']).join('\n');
    } finally {
      await client.query('ROLLBACK');
    }
  });
}

describe('BRIN sargability of the four statements (section 5.2)', () => {
  it('runs with every index of migration 0006 in place', async () => {
    const rows = await testApp.container.db.query<{ indexname: string }>(LIST_AUDIT_INDEXES);
    expect(rows.map((row) => row.indexname)).toEqual(
      expect.arrayContaining([
        'audit_logs_occurred_at_brin',
        'audit_logs_action_idx',
        'audit_logs_actor_idx',
      ]),
    );
  });

  it.each(Object.entries(AUDIT_STATS_SQL))(
    '%s uses audit_logs_occurred_at_brin with enable_seqscan = off',
    async (_name, statement: NamedSql) => {
      const plan = await explainWithoutSeqScan(testApp.container, statement.text, [
        proofWindowStart,
        proofWindowEnd,
      ]);
      expect(plan).toContain('Bitmap Index Scan on audit_logs_occurred_at_brin');
      expect(plan).not.toContain('Seq Scan on audit_logs');
    },
  );

  it('the view form (date_trunc bucket filter) cannot use the BRIN - the negative control', async () => {
    const plan = await explainWithoutSeqScan(testApp.container, VIEW_SHAPED_ACTIONS_HOURLY, [
      proofWindowStart,
      proofWindowEnd,
    ]);
    expect(plan).not.toContain('audit_logs_occurred_at_brin');
    // Whatever scans the table, no index bounds it on occurred_at: every row is read and filtered.
    expect(plan).not.toMatch(/Index Cond: .*occurred_at/);
  });
});
