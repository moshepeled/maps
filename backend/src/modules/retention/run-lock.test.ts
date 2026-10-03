import { pino } from 'pino';
import { describe, expect, it } from 'vitest';

import { RETENTION_LOCK_KEY, withAdvisoryLock } from './run-lock.js';
import type { LockSession } from './run-lock.js';

const logger = pino({ level: 'silent' });

interface FakeSessionOptions {
  locked?: boolean;
  tryLockError?: Error;
  unlockError?: Error;
  unlocked?: boolean;
}

/** A lock session recording its calls (named after the repository's statements) and how it was released. */
function fakeSession(options: FakeSessionOptions = {}) {
  const statements: { name: string; params: readonly unknown[] }[] = [];
  const releases: (Error | undefined)[] = [];
  const session: LockSession = {
    tryLock(key) {
      statements.push({ name: 'retention.tryLock', params: [key] });
      if (options.tryLockError !== undefined) return Promise.reject(options.tryLockError);
      return Promise.resolve(options.locked ?? true);
    },
    unlock(key) {
      statements.push({ name: 'retention.unlock', params: [key] });
      if (options.unlockError !== undefined) return Promise.reject(options.unlockError);
      return Promise.resolve(options.unlocked ?? true);
    },
    release(error?: Error) {
      releases.push(error);
    },
  };
  return { session, statements, releases, connect: () => Promise.resolve(session) };
}

describe('withAdvisoryLock (section 5.6 retention singleton)', () => {
  it('runs the task under pg_try_advisory_lock(7210002), unlocks and returns the connection to the pool', async () => {
    const { connect, statements, releases } = fakeSession();
    const outcome = await withAdvisoryLock(connect, () => Promise.resolve('done'), logger);
    expect(outcome).toEqual({ acquired: true, value: 'done' });
    expect(statements).toEqual([
      { name: 'retention.tryLock', params: [RETENTION_LOCK_KEY] },
      { name: 'retention.unlock', params: [RETENTION_LOCK_KEY] },
    ]);
    expect(RETENTION_LOCK_KEY).toBe(7_210_002);
    expect(releases).toEqual([undefined]);
  });

  it('skips at once when another session holds the lock (no task, no unlock)', async () => {
    const { connect, statements, releases } = fakeSession({ locked: false });
    let ran = false;
    const outcome = await withAdvisoryLock(
      connect,
      () => {
        ran = true;
        return Promise.resolve();
      },
      logger,
    );
    expect(outcome).toEqual({ acquired: false });
    expect(ran).toBe(false);
    expect(statements.map((statement) => statement.name)).toEqual(['retention.tryLock']);
    expect(releases).toEqual([undefined]);
  });

  it('DESTROYS the client (release(err)) when the unlock fails, so a leaked lock cannot outlive it', async () => {
    const unlockError = new Error('Connection terminated');
    const { connect, releases } = fakeSession({ unlockError });
    const outcome = await withAdvisoryLock(connect, () => Promise.resolve(1), logger);
    expect(outcome).toEqual({ acquired: true, value: 1 });
    expect(releases).toEqual([unlockError]);
  });

  it('destroys the client when the unlock reports the lock was not held', async () => {
    const { connect, releases } = fakeSession({ unlocked: false });
    await withAdvisoryLock(connect, () => Promise.resolve(1), logger);
    expect(releases).toHaveLength(1);
    expect(releases[0]).toBeInstanceOf(Error);
  });

  it('unlocks and rethrows when the task fails', async () => {
    const { connect, statements, releases } = fakeSession();
    await expect(
      withAdvisoryLock(connect, () => Promise.reject(new Error('purge failed')), logger),
    ).rejects.toThrow('purge failed');
    expect(statements.map((statement) => statement.name)).toEqual(['retention.tryLock', 'retention.unlock']);
    expect(releases).toEqual([undefined]);
  });

  it('destroys the client when the lock query itself fails', async () => {
    const tryLockError = new Error('Connection terminated unexpectedly');
    const { connect, releases } = fakeSession({ tryLockError });
    await expect(withAdvisoryLock(connect, () => Promise.resolve(1), logger)).rejects.toThrow(tryLockError);
    expect(releases).toEqual([tryLockError]);
  });
});
