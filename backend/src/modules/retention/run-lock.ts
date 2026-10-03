/**
 * Singleton guard of the retention job (SPEC section 5.6, section 10.10): `pg_try_advisory_lock(7210002)` on a DEDICATED pooled
 * client, so exactly one instance purges at a time and a busy lock is skipped instead of awaited. The session lock is
 * released with `pg_advisory_unlock` in `finally`; if the unlock fails (or reports the lock was not held), the client
 * is released with `release(err)` - destroyed rather than returned to the pool - so a leaked session lock can never
 * outlive it and block every later run. Pure orchestration: the SQL lives in `retention.repository.ts`.
 */
import type { Logger } from '../../infra/logger.js';

/** The advisory lock key of the retention job (migrations use their own). */
export const RETENTION_LOCK_KEY = 7_210_002;

/** A dedicated connection: the lock lives exactly as long as this session. */
export interface LockSession {
  /** `pg_try_advisory_lock(key)`: true when this session now holds the lock, false when another one does. */
  tryLock(key: number): Promise<boolean>;
  /** `pg_advisory_unlock(key)`: true when this session held the lock and released it. */
  unlock(key: number): Promise<boolean>;
  /** `release(error)` destroys the connection instead of returning it to the pool. */
  release(error?: Error): void;
}

export type LockOutcome<T> = { acquired: true; value: T } | { acquired: false };

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

/**
 * Runs `task` while holding the advisory lock, or resolves `{ acquired: false }` at once when another session holds
 * it. Errors of `task` propagate after the lock is released.
 */
export async function withAdvisoryLock<T>(
  connect: () => Promise<LockSession>,
  task: () => Promise<T>,
  logger: Logger,
  key: number = RETENTION_LOCK_KEY,
): Promise<LockOutcome<T>> {
  const session = await connect();
  let destroyReason: Error | undefined;
  try {
    let locked: boolean;
    try {
      locked = await session.tryLock(key);
    } catch (error) {
      // The connection's state is unknown: never hand it back to the pool.
      destroyReason = asError(error);
      throw error;
    }
    if (!locked) return { acquired: false };
    try {
      return { acquired: true, value: await task() };
    } finally {
      destroyReason = await unlock(session, key, logger);
    }
  } finally {
    session.release(destroyReason);
  }
}

/** Releases the session lock; returns the reason to destroy the connection when that did not work. */
async function unlock(session: LockSession, key: number, logger: Logger): Promise<Error | undefined> {
  try {
    if (await session.unlock(key)) return undefined;
    const error = new Error('pg_advisory_unlock reported that the retention lock was not held');
    logger.warn({ err: error }, 'retention lock release failed; destroying the connection');
    return error;
  } catch (error) {
    logger.warn({ err: error }, 'retention lock release failed; destroying the connection');
    return asError(error);
  }
}
