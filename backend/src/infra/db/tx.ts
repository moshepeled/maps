/**
 * Transactions (SPEC section 3.3 `Db.withTransaction`): BEGIN with the requested isolation/access mode, an optional
 * per-transaction timeout override (server `statement_timeout` via `SET LOCAL` semantics + client `query_timeout`),
 * COMMIT or ROLLBACK, and a client that is destroyed instead of reused when its state is unknown.
 */
import type pg from 'pg';

import type { Logger } from '../logger.js';
import type { Metrics } from '../metrics/metrics.js';
import { QUERY_TIMEOUT_MARGIN_MS, runNamed } from './execute.js';
import type { DbTx, Isolation, TransactionOptions } from './types.js';
import { sql } from './types.js';

/** `set_config(..., is_local = true)` is `SET LOCAL` with a bind parameter (SET itself cannot take parameters). */
const SET_LOCAL_STATEMENT_TIMEOUT = sql(
  'db.setLocalStatementTimeout',
  "SELECT set_config('statement_timeout', $1, true)",
);

const ISOLATION_SQL: Record<Isolation, string> = {
  'read committed': 'READ COMMITTED',
  'repeatable read': 'REPEATABLE READ',
  serializable: 'SERIALIZABLE',
};

function beginStatement(opts: TransactionOptions): string {
  const parts = ['BEGIN'];
  if (opts.isolation !== undefined) parts.push(`ISOLATION LEVEL ${ISOLATION_SQL[opts.isolation]}`);
  if (opts.readOnly === true) parts.push('READ ONLY');
  return parts.join(' ');
}

/** A client whose query timed out client-side may still be executing: never hand it back to the pool. */
function isUnsafeToReuse(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error.message === 'Query read timeout' || error.message.includes('Connection terminated'))
  );
}

interface TxDeps {
  pool: pg.Pool;
  metrics: Metrics;
  logger: Logger;
}

export async function runTransaction<T>(
  { pool, metrics, logger }: TxDeps,
  fn: (tx: DbTx) => Promise<T>,
  opts: TransactionOptions,
): Promise<T> {
  const client = await pool.connect();
  const queryTimeoutMs = opts.timeoutMs === undefined ? undefined : opts.timeoutMs + QUERY_TIMEOUT_MARGIN_MS;
  let releaseError: Error | undefined;
  try {
    await client.query(beginStatement(opts));
    if (opts.timeoutMs !== undefined) {
      await runNamed(client, metrics, SET_LOCAL_STATEMENT_TIMEOUT, [`${opts.timeoutMs}ms`], queryTimeoutMs);
    }
    const tx: DbTx = {
      query: (stmt, params = []) => runNamed(client, metrics, stmt, params, queryTimeoutMs),
    };
    const result = await fn(tx);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    if (isUnsafeToReuse(error)) {
      releaseError = error instanceof Error ? error : new Error(String(error));
    } else {
      try {
        await client.query('ROLLBACK');
      } catch (rollbackError) {
        logger.warn({ err: rollbackError }, 'ROLLBACK failed; discarding the connection');
        releaseError = rollbackError instanceof Error ? rollbackError : new Error(String(rollbackError));
      }
    }
    throw error;
  } finally {
    // release(err) destroys the client instead of returning it to the pool.
    client.release(releaseError);
  }
}
