import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { systemScheduler } from '../lib/scheduler';
import { CLOCK_TICK_MS, createClockStore } from './clockStore';

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('clockStore (render-pure "now" for countdowns and relative times)', () => {
  it('ticks once a second while started, can be ticked on demand, and stops cleanly', () => {
    const clock = createClockStore(systemScheduler);
    const start = clock.store.getState().now;
    clock.start();
    clock.start();
    vi.advanceTimersByTime(CLOCK_TICK_MS * 3);
    expect(clock.store.getState().now - start).toBe(CLOCK_TICK_MS * 3);
    clock.stop();
    const stopped = clock.store.getState().now;
    vi.advanceTimersByTime(CLOCK_TICK_MS * 5);
    expect(clock.store.getState().now).toBe(stopped);
    vi.advanceTimersByTime(250);
    clock.store.getState().tick();
    expect(clock.store.getState().now).toBe(stopped + CLOCK_TICK_MS * 5 + 250);
  });
});
