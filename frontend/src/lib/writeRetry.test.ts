import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { apiProblem, networkError } from '../test/workspaceHarness';
import { ApiError } from '../api/http';
import { systemScheduler } from './scheduler';
import { classifyFailure, isStorageUnavailable, retryDelayMs, runWrite } from './writeRetry';

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('runWrite - the committed-write retry policy (UX F-03 step 9, F-12)', () => {
  it('resolves the value of a successful write', async () => {
    const handle = runWrite(() => Promise.resolve(42), { scheduler: systemScheduler });
    await expect(handle.result).resolves.toEqual({ ok: true, value: 42 });
  });

  it('UX-AC-63 429: counts down from the body retryAfterMs (not the header) and sends automatically at 0', async () => {
    const operation = vi
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce(apiProblem(429, 'RATE_LIMITED', { retryAfterMs: 5000 }, 5000))
      .mockResolvedValueOnce('saved');
    const countdowns: (number | null)[] = [];
    const started = Date.now();
    const handle = runWrite(operation, {
      scheduler: systemScheduler,
      onCountdown: (until) => countdowns.push(until === null ? null : until - started),
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(countdowns).toEqual([5000]);
    expect(operation).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(4999);
    expect(operation).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    await expect(handle.result).resolves.toEqual({ ok: true, value: 'saved' });
    expect(operation).toHaveBeenCalledTimes(2);
    expect(countdowns).toEqual([5000, null]);
  });

  it('429 without any hint waits the 60 s default', async () => {
    const operation = vi
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce(apiProblem(429, 'RATE_LIMITED'))
      .mockResolvedValueOnce('ok');
    const handle = runWrite(operation, { scheduler: systemScheduler });
    await vi.advanceTimersByTimeAsync(59_999);
    expect(operation).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    await expect(handle.result).resolves.toMatchObject({ ok: true });
  });

  it('cancel during the countdown sends nothing and reports a cancellation', async () => {
    const operation = vi
      .fn<() => Promise<string>>()
      .mockRejectedValue(apiProblem(429, 'RATE_LIMITED', {}, 10_000));
    const handle = runWrite(operation, { scheduler: systemScheduler });
    await vi.advanceTimersByTimeAsync(1000);
    handle.cancel();
    await expect(handle.result).resolves.toEqual({ ok: false, cancelled: true });
    await vi.advanceTimersByTimeAsync(20_000);
    expect(operation).toHaveBeenCalledTimes(1);
  });

  it('UX-AC-92 503 twice then success: retried after Retry-After while the storage toast is up, exactly one success', async () => {
    const storage = apiProblem(503, 'DEPENDENCY_UNAVAILABLE', {}, 5000);
    const operation = vi
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce(storage)
      .mockRejectedValueOnce(storage)
      .mockResolvedValueOnce('created');
    const retrying: boolean[] = [];
    const handle = runWrite(operation, {
      scheduler: systemScheduler,
      onStorageRetry: (active) => retrying.push(active),
    });
    await vi.advanceTimersByTimeAsync(10_000);
    await expect(handle.result).resolves.toEqual({ ok: true, value: 'created' });
    expect(operation).toHaveBeenCalledTimes(3);
    expect(retrying).toEqual([true, true, false]);
  });

  it('UX-AC-92 four consecutive 503s end as a server failure after 3 retries', async () => {
    const operation = vi.fn<() => Promise<string>>().mockRejectedValue(apiProblem(503, 'REQUEST_TIMEOUT'));
    const handle = runWrite(operation, { scheduler: systemScheduler });
    await vi.advanceTimersByTimeAsync(60_000);
    await expect(handle.result).resolves.toMatchObject({ ok: false, cancelled: false, reason: 'server' });
    expect(operation).toHaveBeenCalledTimes(4);
  });

  it('classifies network errors, timeouts, 5xx and typed problems', async () => {
    const cases: [unknown, string][] = [
      [networkError(), 'network'],
      [new ApiError('timeout', 0, 'TIMEOUT', null, null, 'timeout'), 'timeout'],
      [apiProblem(500, 'INTERNAL_ERROR'), 'server'],
      [apiProblem(422, 'INVALID_GEOMETRY'), 'problem'],
      [new Error('boom'), 'network'],
    ];
    for (const [error, reason] of cases) {
      const handle = runWrite(() => Promise.reject(error as Error), { scheduler: systemScheduler });
      await expect(handle.result).resolves.toMatchObject({ ok: false, reason });
    }
    expect(classifyFailure(apiProblem(409, 'VERSION_CONFLICT'))).toBe('problem');
  });

  it('helpers: storage-unavailable codes and retry delays', () => {
    expect(isStorageUnavailable(apiProblem(503, 'SERVICE_UNAVAILABLE'))).toBe(true);
    expect(isStorageUnavailable(apiProblem(503, 'SOME_OTHER_CODE'))).toBe(false);
    expect(isStorageUnavailable(apiProblem(500, 'INTERNAL_ERROR'))).toBe(false);
    expect(retryDelayMs(apiProblem(429, 'RATE_LIMITED', {}, 1234), 60_000)).toBe(1234);
    expect(retryDelayMs(apiProblem(429, 'RATE_LIMITED'), 60_000)).toBe(60_000);
    expect(retryDelayMs(new Error('x'), 7)).toBe(7);
  });
});
