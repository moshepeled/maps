import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { withTimeout } from './timeout.js';

describe('withTimeout', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('resolves with the task value and clears its timer', async () => {
    await expect(withTimeout(Promise.resolve(42), 1000)).resolves.toBe(42);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('propagates the task rejection', async () => {
    await expect(withTimeout(Promise.reject(new Error('boom')), 1000)).rejects.toThrow('boom');
    expect(vi.getTimerCount()).toBe(0);
  });

  it('rejects once the deadline passes while the task is still pending', async () => {
    const pending = withTimeout(new Promise<never>(() => undefined), 1000);
    const rejection = expect(pending).rejects.toThrow('timed out after 1000 ms');
    await vi.advanceTimersByTimeAsync(999);
    expect(vi.getTimerCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    await rejection;
    expect(vi.getTimerCount()).toBe(0);
  });

  it("unref's the timer so a forgotten race cannot keep the process alive", () => {
    vi.useRealTimers();
    const timeouts = vi.spyOn(globalThis, 'setTimeout');
    try {
      void withTimeout(new Promise<never>(() => undefined), 50).catch(() => undefined);
      const handle = timeouts.mock.results[0]?.value as NodeJS.Timeout;
      expect(handle.hasRef()).toBe(false);
    } finally {
      timeouts.mockRestore();
    }
  });
});
