import { pino } from 'pino';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ActiveSession, SessionReader } from '../../infra/directory/types.js';
import type { Metrics } from '../../infra/metrics/metrics.js';
import type { Connection } from './connection.js';
import { ConnectionRegistry } from './connection-registry.js';
import { SessionRevalidator, jitteredDelay } from './session-revalidation.js';

const INTERVAL_MS = 500;

function fakeConnection(id: string, sessionId: string): Connection {
  // The revalidator reads id, identity.sessionId and isOpen only.
  return { id, identity: { userId: 'u', sessionId }, isOpen: true } as unknown as Connection;
}

function activeSession(sessionId: string): ActiveSession {
  return {
    sessionId,
    userId: 'u',
    role: 'user',
    absoluteExpiresAt: new Date(8.64e15),
    expiresAt: new Date(8.64e15),
  };
}

function setup(sessions: SessionReader) {
  const registry = new ConnectionRegistry();
  const runs: string[] = [];
  let closes = 0;
  const metrics = {
    wsRevalidationRunsTotal: { inc: ({ result }: { result: string }) => runs.push(result) },
    wsRevalidationClosesTotal: {
      inc: () => {
        closes += 1;
      },
    },
  } as unknown as Metrics;
  const closed: string[] = [];
  const revalidator = new SessionRevalidator({
    sessions,
    registry,
    intervalMs: INTERVAL_MS,
    jitter: 0.1,
    batchSize: 2,
    random: () => 0.5,
    logger: pino({ level: 'silent' }),
    metrics,
    onInactive: (connection) => closed.push(connection.id),
  });
  const add = (id: string, sessionId: string) => {
    const reservation = registry.tryReserve('u', { maxPerInstance: 100, maxPerUser: 100 });
    if (!reservation.ok) throw new Error('capacity');
    registry.add(fakeConnection(id, sessionId), reservation.reservation);
  };
  return { revalidator, add, runs, closed, closes: () => closes };
}

beforeEach(() => {
  vi.useFakeTimers({ now: 0 });
});

afterEach(() => {
  vi.useRealTimers();
});

describe('jitteredDelay (+/-10 %)', () => {
  it('stays within interval x [0.9, 1.1]', () => {
    expect(jitteredDelay(60_000, 0.1, () => 0)).toBe(54_000);
    expect(jitteredDelay(60_000, 0.1, () => 0.5)).toBe(60_000);
    expect(jitteredDelay(60_000, 0.1, () => 0.999_999)).toBeLessThanOrEqual(66_000);
  });
});

describe('SessionRevalidator (section 7.2 step 5)', () => {
  it('closes the sockets of inactive sessions, in batches of at most batchSize ids', async () => {
    const calls: string[][] = [];
    const sessions: SessionReader = {
      getActive: () => Promise.resolve(null),
      getActiveMany: (ids) => {
        calls.push([...ids]);
        return Promise.resolve(new Map(ids.filter((id) => id !== 's2').map((id) => [id, activeSession(id)])));
      },
    };
    const { revalidator, add, runs, closed, closes } = setup(sessions);
    add('c1', 's1');
    add('c2', 's2');
    add('c3', 's2');
    add('c4', 's3');
    await revalidator.runNow();
    expect(calls.every((batch) => batch.length <= 2)).toBe(true);
    expect(calls.flat().sort()).toEqual(['s1', 's2', 's3']);
    expect(closed.sort()).toEqual(['c2', 'c3']);
    expect(runs).toEqual(['ok']);
    expect(closes()).toBe(2);
  });

  it('skips the round on a DB error (fail-open) and counts it', async () => {
    const sessions: SessionReader = {
      getActive: () => Promise.resolve(null),
      getActiveMany: () => Promise.reject(new Error('connection refused')),
    };
    const { revalidator, add, runs, closed } = setup(sessions);
    add('c1', 's1');
    await revalidator.runNow();
    expect(runs).toEqual(['db_error']);
    expect(closed).toEqual([]);
  });

  it('runs on its (jittered) interval once started and stops cleanly', async () => {
    const getActiveMany = vi.fn((ids: readonly string[]) =>
      Promise.resolve(new Map(ids.map((id) => [id, activeSession(id)]))),
    );
    const { revalidator, add, runs } = setup({ getActive: () => Promise.resolve(null), getActiveMany });
    add('c1', 's1');
    revalidator.start();
    revalidator.start();
    await vi.advanceTimersByTimeAsync(INTERVAL_MS);
    await vi.advanceTimersByTimeAsync(INTERVAL_MS);
    expect(runs).toEqual(['ok', 'ok']);
    revalidator.stop();
    await vi.advanceTimersByTimeAsync(INTERVAL_MS * 4);
    expect(runs).toHaveLength(2);
  });

  it('three runNow() calls give three sequential rounds that never overlap', async () => {
    vi.useRealTimers();
    const events: string[] = [];
    const releases: (() => void)[] = [];
    const sessions: SessionReader = {
      getActive: () => Promise.resolve(null),
      getActiveMany: (ids) =>
        new Promise((resolve) => {
          const round = releases.length + 1;
          events.push(`start:${round}`);
          releases.push(() => {
            events.push(`end:${round}`);
            resolve(new Map(ids.map((id) => [id, activeSession(id)])));
          });
        }),
    };
    const { revalidator, add, runs } = setup(sessions);
    add('c1', 's1');
    const rounds = [revalidator.runNow(), revalidator.runNow(), revalidator.runNow()];
    // A macrotask lets every pending microtask of the round chain settle.
    const settle = () => new Promise<void>((resolve) => setImmediate(resolve));
    await settle();
    expect(events).toEqual(['start:1']);
    releases[0]?.();
    await settle();
    expect(events).toEqual(['start:1', 'end:1', 'start:2']);
    releases[1]?.();
    await settle();
    releases[2]?.();
    await Promise.all(rounds);
    expect(events).toEqual(['start:1', 'end:1', 'start:2', 'end:2', 'start:3', 'end:3']);
    expect(runs).toEqual(['ok', 'ok', 'ok']);
  });
});
