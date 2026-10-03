import { describe, expect, it } from 'vitest';

import { InMemoryDrawRateLimiter } from './in-memory.js';

function limiter(maxUsers?: number) {
  let now = 0;
  const instance = new InMemoryDrawRateLimiter({
    limit: 50,
    windowMs: 60_000,
    clock: { now: () => now },
    ...(maxUsers === undefined ? {} : { maxUsers }),
  });
  return {
    instance,
    at: (ms: number) => {
      now = ms;
    },
  };
}

describe('InMemoryDrawRateLimiter (exact sliding window, section 10.1)', () => {
  it('allows 50 actions per rolling minute and rejects the 51st with retryAfter', async () => {
    const { instance, at } = limiter();
    for (let i = 0; i < 50; i += 1) {
      at(i * 100);
      const decision = await instance.consume('alice', 'area.create');
      expect(decision).toMatchObject({ allowed: true, limit: 50, remaining: 49 - i, resetAtMs: 60_000 });
    }
    at(10_000);
    const rejected = await instance.consume('alice', 'draft.start');
    expect(rejected).toEqual({
      allowed: false,
      limit: 50,
      remaining: 0,
      retryAfterMs: 50_000,
      resetAtMs: 60_000,
    });
  });

  it('slides: an action leaves the window exactly one window later', async () => {
    const { instance, at } = limiter();
    at(0);
    for (let i = 0; i < 50; i += 1) await instance.consume('bob', 'area.update');
    at(59_999);
    expect((await instance.consume('bob', 'area.update')).allowed).toBe(false);
    at(60_000);
    const decision = await instance.consume('bob', 'area.update');
    expect(decision).toMatchObject({ allowed: true, remaining: 49 });
  });

  it('keeps users independent and bounds the tracked users (least recently used evicted)', async () => {
    const { instance, at } = limiter(2);
    at(0);
    for (let i = 0; i < 50; i += 1) await instance.consume('carol', 'area.delete');
    expect((await instance.consume('dave', 'area.delete')).allowed).toBe(true);
    expect((await instance.consume('carol', 'area.delete')).allowed).toBe(false);
    await instance.consume('erin', 'area.restore');
    await instance.consume('frank', 'area.restore');
    // carol was evicted (bounded memory): her window restarts.
    expect((await instance.consume('carol', 'area.delete')).allowed).toBe(true);
  });
});
