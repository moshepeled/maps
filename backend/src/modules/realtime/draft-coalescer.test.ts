import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { DraftCoalescer } from './draft-coalescer.js';

const COALESCE_MS = 50;
const KEYFRAME_MS = 5000;

interface Published {
  state: number;
  at: number;
}

function setup() {
  const published: Published[] = [];
  const coalescer = new DraftCoalescer<number>({
    coalesceMs: COALESCE_MS,
    keyframeMs: KEYFRAME_MS,
    publish: (state) => published.push({ state, at: Date.now() }),
  });
  return { coalescer, published };
}

beforeEach(() => {
  vi.useFakeTimers({ now: 0 });
});

afterEach(() => {
  vi.useRealTimers();
});

describe('DraftCoalescer (section 7.6: 50 ms trailing coalescing, 5 s keyframes)', () => {
  it('publishes only the latest state, once, coalesceMs after the first push', () => {
    const { coalescer, published } = setup();
    for (let rev = 1; rev <= 10; rev += 1) {
      coalescer.push(rev);
      vi.advanceTimersByTime(3);
    }
    expect(published).toEqual([]);
    vi.advanceTimersByTime(COALESCE_MS - 30);
    expect(published).toEqual([{ state: 10, at: COALESCE_MS }]);
    expect(coalescer.latest).toBe(10);
  });

  it('starts a new window after a publish', () => {
    const { coalescer, published } = setup();
    coalescer.push(1);
    vi.advanceTimersByTime(COALESCE_MS);
    coalescer.push(2);
    coalescer.push(3);
    vi.advanceTimersByTime(COALESCE_MS);
    expect(published.map((entry) => entry.state)).toEqual([1, 3]);
  });

  it('re-publishes the latest state as a keyframe while the draft is idle', () => {
    const { coalescer, published } = setup();
    coalescer.push(7);
    vi.advanceTimersByTime(COALESCE_MS + 2 * KEYFRAME_MS);
    expect(published).toEqual([
      { state: 7, at: COALESCE_MS },
      { state: 7, at: COALESCE_MS + KEYFRAME_MS },
      { state: 7, at: COALESCE_MS + 2 * KEYFRAME_MS },
    ]);
  });

  it('postpones the keyframe while updates keep flowing', () => {
    const { coalescer, published } = setup();
    for (let i = 0; i < 20; i += 1) {
      coalescer.push(i);
      vi.advanceTimersByTime(1000);
    }
    // One trailing publish per second, never an extra keyframe in between.
    expect(published).toHaveLength(20);
    expect(published.every((entry, index) => entry.at === index * 1000 + COALESCE_MS)).toBe(true);
  });

  it('publishNow publishes at once (the rev-0 start announcement) and drops a pending trailing publish', () => {
    const { coalescer, published } = setup();
    coalescer.push(1);
    coalescer.publishNow(0);
    expect(published).toEqual([{ state: 0, at: 0 }]);
    vi.advanceTimersByTime(COALESCE_MS);
    expect(published).toHaveLength(1);
    vi.advanceTimersByTime(KEYFRAME_MS);
    expect(published.at(-1)).toEqual({ state: 0, at: KEYFRAME_MS });
  });

  it('cancel() discards the pending update (not flushed) and stops the keyframes', () => {
    const { coalescer, published } = setup();
    coalescer.push(1);
    vi.advanceTimersByTime(COALESCE_MS);
    coalescer.push(2);
    coalescer.cancel();
    expect(vi.getTimerCount()).toBe(0);
    vi.advanceTimersByTime(KEYFRAME_MS * 3);
    expect(published.map((entry) => entry.state)).toEqual([1]);
  });

  it('ignores pushes and immediate publishes after cancel (idempotent cancel)', () => {
    const { coalescer, published } = setup();
    coalescer.cancel();
    coalescer.cancel();
    coalescer.push(1);
    coalescer.publishNow(2);
    vi.advanceTimersByTime(KEYFRAME_MS * 2);
    expect(published).toEqual([]);
    expect(coalescer.latest).toBeNull();
  });
});
