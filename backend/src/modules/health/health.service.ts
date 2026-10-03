/**
 * Readiness evaluation (SPEC section 10.9): database, critical Redis, pending migrations and the shutdown flag, checked in
 * parallel with a 1 s budget each. Only a Redis failure degrades (the instance can still serve REST); a failing
 * database, pending migrations or a shutting-down instance fail readiness. Error strings are short and sanitised.
 */
import type { ReadyResponse } from '@snapland/shared';
import type { Redis } from 'ioredis';

import { pgErrorCode } from '../../infra/db/execute.js';
import { countPendingMigrations } from '../../infra/db/migrations.js';
import type { Db } from '../../infra/db/types.js';
import { withTimeout } from '../../infra/timeout.js';

const CHECK_TIMEOUT_MS = 1000;

type DependencyCheck = ReadyResponse['checks']['database'];

/** A short, credential-free description of a failure (never hosts, ports or connection strings). */
function describeFailure(error: unknown): string {
  const code = pgErrorCode(error);
  if (code !== 'unknown') return /^[A-Z0-9_]{2,32}$/.test(code) ? code : 'unavailable';
  if (error instanceof Error && error.message.includes('timed out')) return 'timeout';
  return 'unavailable';
}

async function checkDatabase(db: Db): Promise<DependencyCheck> {
  try {
    return { status: 'ok', latencyMs: await db.ping(CHECK_TIMEOUT_MS) };
  } catch (error) {
    return { status: 'fail', error: describeFailure(error) };
  }
}

async function checkRedis(client: Redis): Promise<DependencyCheck> {
  const started = performance.now();
  try {
    await withTimeout(client.ping(), CHECK_TIMEOUT_MS);
    return { status: 'ok', latencyMs: Math.round(performance.now() - started) };
  } catch (error) {
    return { status: 'fail', error: describeFailure(error) };
  }
}

async function checkMigrations(db: Db): Promise<ReadyResponse['checks']['migrations']> {
  try {
    const pending = await withTimeout(countPendingMigrations(db), CHECK_TIMEOUT_MS);
    return pending === 0 ? { status: 'ok', pending } : { status: 'fail', pending };
  } catch (error) {
    return { status: 'fail', error: describeFailure(error) };
  }
}

export interface ReadinessDeps {
  db: Db;
  redis: Redis;
  cacheRedis: Redis | null;
  isShuttingDown: () => boolean;
}

export async function evaluateReadiness(
  deps: ReadinessDeps,
): Promise<Pick<ReadyResponse, 'status' | 'checks'>> {
  const [database, redis, migrations, cache] = await Promise.all([
    checkDatabase(deps.db),
    checkRedis(deps.redis),
    checkMigrations(deps.db),
    deps.cacheRedis === null ? Promise.resolve(null) : checkRedis(deps.cacheRedis),
  ]);
  const shutdown = { status: deps.isShuttingDown() ? ('fail' as const) : ('ok' as const) };
  const failed = database.status === 'fail' || migrations.status === 'fail' || shutdown.status === 'fail';
  return {
    status: failed ? 'fail' : redis.status === 'fail' ? 'degraded' : 'ok',
    checks: {
      database,
      redis,
      migrations,
      shutdown,
      cacheRedis:
        cache === null
          ? { status: 'disabled' }
          : cache.status === 'ok'
            ? { status: 'ok' }
            : { status: 'fail', error: cache.error ?? 'unavailable' },
    },
  };
}
