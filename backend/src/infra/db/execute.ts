/** Execution of named statements with latency/error metrics, shared by the pool and transactions. */
import type pg from 'pg';
import type { QueryResultRow } from 'pg';

import type { Metrics } from '../metrics/metrics.js';
import type { NamedSql } from './types.js';

/** The client-side read timeout exceeds the server statement timeout by this much, so the server cancels first. */
export const QUERY_TIMEOUT_MARGIN_MS = 1000;

/** SQLSTATE of a pg error, a Node system error code, or 'unknown' (metric label). */
export function pgErrorCode(error: unknown): string {
  if (typeof error === 'object' && error !== null && 'code' in error && typeof error.code === 'string') {
    return error.code;
  }
  return 'unknown';
}

/** Executes one named statement on a pool or client, recording latency and error metrics. */
export async function runNamed<R extends QueryResultRow>(
  executor: pg.Pool | pg.PoolClient,
  metrics: Metrics,
  stmt: NamedSql,
  params: readonly unknown[],
  queryTimeoutMs?: number,
): Promise<R[]> {
  const stopTimer = metrics.dbQueryDuration.startTimer({ query: stmt.name });
  try {
    const config: pg.QueryConfig & { query_timeout?: number } = {
      name: stmt.name,
      text: stmt.text,
      values: [...params],
    };
    if (queryTimeoutMs !== undefined) config.query_timeout = queryTimeoutMs;
    const result = await executor.query<R>(config);
    return result.rows;
  } catch (error) {
    metrics.dbErrorsTotal.inc({ code: pgErrorCode(error) });
    throw error;
  } finally {
    stopTimer();
  }
}
