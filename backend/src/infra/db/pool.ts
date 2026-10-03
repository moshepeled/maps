/**
 * PostgreSQL connection pool and the `Db` implementation (SPEC section 5.7): one pg.Pool per instance with statement,
 * client-read and idle-in-transaction timeouts, `application_name = snapland-<instanceId>`, and a per-pool int8 parser
 * (no process-global `pg.types` mutation, so several containers can share a process).
 */
import pg from 'pg';

import type { AppConfig } from '../../config/env.js';
import type { Logger } from '../logger.js';
import type { Metrics } from '../metrics/metrics.js';
import { withTimeout } from '../timeout.js';
import { QUERY_TIMEOUT_MARGIN_MS, pgErrorCode, runNamed } from './execute.js';
import { runTransaction } from './tx.js';
import type { Db } from './types.js';

const INT8_OID = 20;
const IDLE_IN_TRANSACTION_TIMEOUT_MS = 10_000;

/** int8 -> number, refusing values that would silently lose precision (> 2^53). */
function parseInt8(value: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) {
    throw new RangeError(`int8 value ${value} exceeds Number.MAX_SAFE_INTEGER`);
  }
  return parsed;
}

export function createPool(config: AppConfig, instanceId: string): pg.Pool {
  const types = new pg.TypeOverrides();
  types.setTypeParser(INT8_OID, parseInt8);
  return new pg.Pool({
    connectionString: config.DATABASE_URL,
    max: config.DB_POOL_MAX,
    idleTimeoutMillis: config.DB_IDLE_TIMEOUT_MS,
    connectionTimeoutMillis: config.DB_CONNECTION_TIMEOUT_MS,
    statement_timeout: config.DB_STATEMENT_TIMEOUT_MS,
    query_timeout: config.DB_STATEMENT_TIMEOUT_MS + QUERY_TIMEOUT_MARGIN_MS,
    idle_in_transaction_session_timeout: IDLE_IN_TRANSACTION_TIMEOUT_MS,
    application_name: `snapland-${instanceId}`.slice(0, 63),
    types,
  });
}

export interface DbDeps {
  pool: pg.Pool;
  metrics: Metrics;
  logger: Logger;
}

export function createDb({ pool, metrics, logger }: DbDeps): Db {
  pool.on('error', (error) => {
    // Idle-client errors (server restart, network loss) must not crash the process; the pool replaces the client.
    metrics.dbErrorsTotal.inc({ code: pgErrorCode(error) });
    logger.warn({ err: error }, 'idle PostgreSQL client error');
  });
  metrics.onScrape('dbPool', () => {
    metrics.dbPoolConnections.set({ state: 'total' }, pool.totalCount);
    metrics.dbPoolConnections.set({ state: 'idle' }, pool.idleCount);
    metrics.dbPoolConnections.set({ state: 'waiting' }, pool.waitingCount);
  });

  return {
    pool,
    query: (stmt, params = []) => runNamed(pool, metrics, stmt, params),
    withTransaction: (fn, opts = {}) => runTransaction({ pool, metrics, logger }, fn, opts),
    async ping(timeoutMs) {
      const started = performance.now();
      // The race also bounds the wait for a free client, which query_timeout alone does not.
      await withTimeout(
        pool.query({ text: 'SELECT 1', query_timeout: timeoutMs } as pg.QueryConfig),
        timeoutMs,
      );
      return Math.round(performance.now() - started);
    },
  };
}
