import type { AuthResponse } from '@snapland/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ApiError } from '../api/http';
import { systemScheduler } from '../lib/scheduler';
import { ALICE } from '../test/factories';
import { createAuthStore } from './authStore';
import type { LockManagerLike } from './session';
import { SessionManager } from './session';

function authResponse(expiresInMs = 15 * 60_000): AuthResponse {
  return {
    user: {
      id: ALICE.id,
      username: 'alice',
      displayName: 'Alice',
      color: ALICE.color,
      role: 'user',
      createdAt: '2026-09-27T10:00:00.000Z',
    },
    sessionId: '9b2d7c4e-5a61-4f3b-8e2a-1c0d9f8e7a61',
    accessToken: 'token',
    accessTokenExpiresAt: new Date(Date.now() + expiresInMs).toISOString(),
  };
}

function apiError(status: number, code: string, retryAfterMs: number | null = null): ApiError {
  return new ApiError('http', status, code, null, retryAfterMs, code);
}

function setup(callRefresh: () => Promise<AuthResponse>, locks: LockManagerLike | null = null) {
  const store = createAuthStore();
  const sleeps: number[] = [];
  const manager = new SessionManager({
    store,
    scheduler: systemScheduler,
    callRefresh,
    locks,
    sleep: (ms) => {
      sleeps.push(ms);
      return Promise.resolve();
    },
  });
  return { store, manager, sleeps };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(1_790_000_000_000);
});
afterEach(() => {
  vi.useRealTimers();
});

describe('SessionManager (SPEC section 6.2, UX F-01 / F-11)', () => {
  it('boot: a silent refresh signs in; a failed one lands on sign-in without a dialog', async () => {
    const ok = setup(() => Promise.resolve(authResponse()));
    expect(await ok.manager.bootstrap()).toBe(true);
    expect(ok.store.getState().status).toBe('signed-in');
    expect(ok.manager.accessToken()).toBe('token');

    const failed = setup(() => Promise.reject(apiError(401, 'REFRESH_TOKEN_INVALID')));
    expect(await failed.manager.bootstrap()).toBe(false);
    expect(failed.store.getState().status).toBe('signed-out');
    expect(failed.store.getState().sessionProblem).toBeNull();
    expect(failed.sleeps).toEqual([]);
  });

  it('single flight: concurrent refreshes share one call, serialised through Web Locks', async () => {
    const callRefresh = vi.fn(() => Promise.resolve(authResponse()));
    const lockNames: string[] = [];
    const locks: LockManagerLike = {
      request: (name, callback) => {
        lockNames.push(name);
        return callback();
      },
    };
    const { manager } = setup(callRefresh, locks);
    const results = await Promise.all([manager.refresh(), manager.refresh(), manager.refresh()]);
    expect(results.every((result) => result.ok)).toBe(true);
    expect(callRefresh).toHaveBeenCalledTimes(1);
    expect(lockNames).toEqual(['snapland-refresh']);
  });

  it('a revoked session keeps the workspace and opens the revoked dialog', async () => {
    const callRefresh = vi
      .fn<() => Promise<AuthResponse>>()
      .mockResolvedValueOnce(authResponse())
      .mockRejectedValue(apiError(401, 'SESSION_REVOKED'));
    const { store, manager } = setup(callRefresh);
    await manager.bootstrap();
    const outcome = await manager.refresh();
    expect(outcome).toEqual({ ok: false, reason: 'revoked' });
    expect(store.getState().status).toBe('signed-in');
    expect(store.getState().sessionProblem).toBe('revoked');
    expect(store.getState().accessToken).toBeNull();
  });

  it('an expired refresh token retries once (parallel-tab rotation race) before the expired dialog', async () => {
    const callRefresh = vi
      .fn<() => Promise<AuthResponse>>()
      .mockResolvedValueOnce(authResponse())
      .mockRejectedValue(apiError(401, 'REFRESH_TOKEN_INVALID'));
    const { store, manager, sleeps } = setup(callRefresh);
    await manager.bootstrap();
    expect(await manager.refresh()).toEqual({ ok: false, reason: 'expired' });
    expect(callRefresh).toHaveBeenCalledTimes(3);
    expect(sleeps).toEqual([300]);
    expect(store.getState().sessionProblem).toBe('expired');
  });

  it('429 on refresh is not a session failure: wait Retry-After and retry', async () => {
    const callRefresh = vi
      .fn<() => Promise<AuthResponse>>()
      .mockRejectedValueOnce(apiError(429, 'RATE_LIMITED', 2000))
      .mockResolvedValue(authResponse());
    const { store, manager, sleeps } = setup(callRefresh);
    expect(await manager.refresh()).toEqual({ ok: true });
    expect(sleeps).toEqual([2000]);
    expect(store.getState().sessionProblem).toBeNull();
  });

  it('network / 5xx failures are reported as network, never as an ended session', async () => {
    const unavailable = apiError(503, 'DEPENDENCY_UNAVAILABLE');
    const { store, manager } = setup(() => Promise.reject(unavailable));
    // The refresh's own error travels with the outcome, so the waiting request fails with a 503, not a 401.
    expect(await manager.refresh()).toEqual({ ok: false, reason: 'network', cause: unavailable });
    expect(store.getState().sessionProblem).toBeNull();
    const other = setup(() => Promise.reject(new Error('weird')));
    expect(await other.manager.refresh()).toEqual({ ok: false, reason: 'network', cause: null });
  });

  it('refreshes proactively one minute before the access token expires', async () => {
    const callRefresh = vi.fn(() => Promise.resolve(authResponse()));
    const { manager } = setup(callRefresh);
    manager.adopt(authResponse(15 * 60_000));
    await vi.advanceTimersByTimeAsync(14 * 60_000 - 1);
    expect(callRefresh).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(callRefresh).toHaveBeenCalledTimes(1);
    manager.signedOut();
    await vi.advanceTimersByTimeAsync(60 * 60_000);
    expect(callRefresh).toHaveBeenCalledTimes(1);
  });
});
