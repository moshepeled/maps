import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { systemScheduler, Timer } from './scheduler';
import { createDebounce, createThrottle } from './throttle';

describe('createThrottle (<= 1 send per interval, final value never lost)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('sends the first value at once and the latest one on the trailing edge', () => {
    const sent: number[] = [];
    const throttle = createThrottle<number>((value) => sent.push(value), 100, systemScheduler);
    throttle.push(1);
    throttle.push(2);
    throttle.push(3);
    expect(sent).toEqual([1]);
    vi.advanceTimersByTime(100);
    expect(sent).toEqual([1, 3]);
    vi.advanceTimersByTime(500);
    expect(sent).toEqual([1, 3]);
  });

  it('flush sends a pending value now; cancel drops it', () => {
    const sent: number[] = [];
    const throttle = createThrottle<number>((value) => sent.push(value), 100, systemScheduler);
    throttle.push(1);
    throttle.push(2);
    throttle.flush();
    expect(sent).toEqual([1, 2]);
    throttle.push(3);
    throttle.cancel();
    vi.advanceTimersByTime(1000);
    throttle.flush();
    expect(sent).toEqual([1, 2]);
  });
});

describe('createDebounce', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('runs once with the latest value after the quiet period', () => {
    const runs: string[] = [];
    const debounce = createDebounce<string>((value) => runs.push(value), 300, systemScheduler);
    debounce.push('a');
    vi.advanceTimersByTime(200);
    debounce.push('b');
    vi.advanceTimersByTime(299);
    expect(runs).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(runs).toEqual(['b']);
    debounce.push('c');
    debounce.flush();
    debounce.push('d');
    debounce.cancel();
    vi.advanceTimersByTime(1000);
    expect(runs).toEqual(['b', 'c']);
  });

  it('Timer re-arms and reports pending', () => {
    let fired = 0;
    const timer = new Timer(systemScheduler, () => {
      fired += 1;
    });
    timer.arm(10);
    expect(timer.pending).toBe(true);
    timer.arm(20);
    vi.advanceTimersByTime(15);
    expect(fired).toBe(0);
    vi.advanceTimersByTime(5);
    expect(fired).toBe(1);
    expect(timer.pending).toBe(false);
  });
});
