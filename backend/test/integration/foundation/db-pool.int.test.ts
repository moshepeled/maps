import { ProblemSchema } from '@snapland/shared';
import { afterEach, describe, expect, it } from 'vitest';

import { sql } from '../../../src/infra/db/types.js';
import { createTestApp } from '../../helpers/test-app.js';
import type { TestApp } from '../../helpers/test-app.js';
import { timed, waitFor } from '../../helpers/wait-for.js';

const apps: TestApp[] = [];

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

async function app(options: Parameters<typeof createTestApp>[0] = {}): Promise<TestApp> {
  const created = await createTestApp(options);
  apps.push(created);
  return created;
}

const SLEEP = sql('testPool.sleep', 'SELECT pg_sleep($1::float8) AS slept');
const SETTINGS = sql(
  'testPool.settings',
  "SELECT current_setting('statement_timeout') AS statement_timeout, current_setting('application_name') AS application_name",
);
const BIG_INT8 = sql('testPool.bigInt8', 'SELECT 9007199254740993::bigint AS value');
const SAFE_INT8 = sql('testPool.safeInt8', 'SELECT 9007199254740991::bigint AS value');
const TX_STATE = sql(
  'testPool.txState',
  "SELECT current_setting('transaction_isolation') AS isolation, current_setting('transaction_read_only') AS read_only, current_setting('statement_timeout') AS statement_timeout",
);
const TEMP_TABLE = sql(
  'testPool.tempTable',
  'CREATE TEMP TABLE IF NOT EXISTS tx_probe (id int) ON COMMIT DROP',
);
const INSERT_PROBE = sql('testPool.insertProbe', 'INSERT INTO tx_probe VALUES (1)');

describe('connection pool (section 5.7, R38)', () => {
  it('sets statement_timeout = 5s and application_name = snapland-<instanceId> on every connection', async () => {
    const { container } = await app();
    const [row] = await container.db.query<{ statement_timeout: string; application_name: string }>(SETTINGS);
    expect(row).toEqual({ statement_timeout: '5s', application_name: `snapland-${container.instanceId}` });
  });

  it('parses int8 to number and refuses values beyond 2^53', async () => {
    const { container } = await app();
    await expect(container.db.query<{ value: number }>(SAFE_INT8)).resolves.toEqual([
      { value: 9007199254740991 },
    ]);
    await expect(container.db.query(BIG_INT8)).rejects.toThrow(/MAX_SAFE_INTEGER/);
  });

  it('honours pool.max', async () => {
    const { container } = await app({ config: { DB_POOL_MAX: 2 } });
    const sleepers = [0, 1, 2].map(() => container.db.query(SLEEP, [0.3]));
    await waitFor(() => container.db.pool.waitingCount === 1, { description: 'third query waiting' });
    expect(container.db.pool.totalCount).toBe(2);
    await Promise.all(sleepers);
  });

  it('answers 503 DEPENDENCY_UNAVAILABLE + Retry-After: 5 within DB_CONNECTION_TIMEOUT_MS when the pool is exhausted', async () => {
    const testApp = await app({
      config: { DB_POOL_MAX: 1, DB_CONNECTION_TIMEOUT_MS: 500 },
      routes: (scope, container) => {
        scope.get('/query', async () => container.db.query(SLEEP, [0]));
      },
    });
    const holder = testApp.container.db.query(SLEEP, [1.5]);
    await waitFor(
      () => testApp.container.db.pool.idleCount === 0 && testApp.container.db.pool.totalCount === 1,
    );
    const { result: response, elapsedMs } = await timed(() =>
      testApp.app.inject({ method: 'GET', url: '/__test/query' }),
    );
    expect(response.statusCode).toBe(503);
    expect(response.headers['retry-after']).toBe('5');
    expect(ProblemSchema.parse(response.json()).code).toBe('DEPENDENCY_UNAVAILABLE');
    expect(elapsedMs).toBeLessThan(500 + 400);
    await holder;
  });

  it('withTransaction({ timeoutMs: 3000 }) outlives a 500 ms pool default (pg_sleep 1.5 s)', async () => {
    const { container } = await app({ config: { DB_STATEMENT_TIMEOUT_MS: 500 } });
    await expect(container.db.query(SLEEP, [1])).rejects.toMatchObject({ code: '57014' });
    const result = await container.db.withTransaction(
      async (tx) => {
        const [state] = await tx.query<{ statement_timeout: string }>(TX_STATE);
        await tx.query(SLEEP, [1.5]);
        return state;
      },
      { timeoutMs: 3000 },
    );
    expect(result?.statement_timeout).toBe('3s');
    // The override is transaction-local: the pool default applies again afterwards.
    await expect(container.db.query(SLEEP, [1])).rejects.toMatchObject({ code: '57014' });
  });

  it('opens transactions with the requested isolation and access mode, and rolls back on error', async () => {
    const { container } = await app();
    const state = await container.db.withTransaction(
      (tx) => tx.query<{ isolation: string; read_only: string }>(TX_STATE),
      {
        isolation: 'repeatable read',
        readOnly: true,
      },
    );
    expect(state[0]).toMatchObject({ isolation: 'repeatable read', read_only: 'on' });
    await expect(
      container.db.withTransaction(async (tx) => {
        await tx.query(TEMP_TABLE);
        await tx.query(INSERT_PROBE);
        throw new Error('abort');
      }),
    ).rejects.toThrow('abort');
    // The connection went back to the pool in a clean state.
    const [after] = await container.db.query<{ isolation: string }>(TX_STATE);
    expect(after?.isolation).toBe('read committed');
  });

  it('reports ping latency and samples pool gauges on scrape', async () => {
    const testApp = await app();
    expect(await testApp.container.db.ping(1000)).toBeGreaterThanOrEqual(0);
    await testApp.container.db.query(SAFE_INT8);
    const metrics = (await testApp.app.inject({ method: 'GET', url: '/metrics' })).body;
    expect(metrics).toMatch(/snapland_db_pool_connections\{[^}]*state="total"[^}]*\} \d+/);
    expect(metrics).toMatch(/snapland_db_query_duration_seconds_count\{[^}]*query="testPool\.safeInt8"/);
  });
});
