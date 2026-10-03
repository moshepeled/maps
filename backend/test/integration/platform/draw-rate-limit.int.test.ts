/**
 * Drawing-action limiter (SPEC section 10.1, ADR-0008) against the real Redis: the production Redis sliding window of two
 * app instances sharing one Redis, the exact Lua semantics, and the in-memory fallback while the critical Redis is
 * unreachable (TCP proxy paused - shared services are never touched).
 */
import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { RedisDrawRateLimiter } from '../../../src/infra/ratelimit/redis-draw-limiter.js';
import type { RateLimitDecision } from '../../../src/infra/ratelimit/types.js';
import { createTcpProxy } from '../../helpers/tcp-proxy.js';
import type { TcpProxy } from '../../helpers/tcp-proxy.js';
import { createTestApp } from '../../helpers/test-app.js';
import type { TestApp } from '../../helpers/test-app.js';
import { waitFor } from '../../helpers/wait-for.js';
import { metricValue } from './support/metrics.js';

let a: TestApp;
let b: TestApp;

beforeAll(async () => {
  // No modules: these tests exercise the limiter the container wires, nothing else.
  a = await createTestApp({ modules: [] });
  b = await createTestApp({ modules: [] });
});

afterAll(async () => {
  await Promise.all([a.close(), b.close()]);
});

function retryAfter(decision: RateLimitDecision): number {
  if (decision.allowed) throw new Error('expected a rejection');
  return decision.retryAfterMs;
}

describe('draw limiter across instances (section 10.1)', () => {
  it('wires the Redis sliding window as the production limiter', () => {
    expect(a.container.drawRateLimiter).toBeInstanceOf(RedisDrawRateLimiter);
  });

  it('two instances sharing Redis admit exactly 50 per user per 60 s; the 51st gets a correct retryAfterMs', async () => {
    const userId = randomUUID();
    const started = Date.now();
    const decisions: RateLimitDecision[] = [];
    for (let i = 0; i < 50; i += 1) {
      const limiter = i % 2 === 0 ? a.container.drawRateLimiter : b.container.drawRateLimiter;
      decisions.push(await limiter.consume(userId, i % 3 === 0 ? 'draft.start' : 'area.create'));
    }
    expect(decisions.every((decision) => decision.allowed)).toBe(true);
    expect(decisions.map((decision) => decision.remaining)).toEqual(
      Array.from({ length: 50 }, (_, i) => 49 - i),
    );
    expect(decisions.every((decision) => decision.limit === 50)).toBe(true);

    const rejected = await b.container.drawRateLimiter.consume(userId, 'area.update');
    const elapsed = Date.now() - started;
    expect(rejected.allowed).toBe(false);
    expect(rejected.remaining).toBe(0);
    // The oldest entry leaves the window 60 s after it was admitted (Redis TIME; +/-1 ms of rounding).
    expect(retryAfter(rejected)).toBeLessThanOrEqual(60_000);
    expect(retryAfter(rejected)).toBeGreaterThanOrEqual(60_000 - elapsed - 5);
    // Rejections are not recorded: another rejection reports the same (shrinking) wait.
    const again = await a.container.drawRateLimiter.consume(userId, 'area.delete');
    expect(retryAfter(again)).toBeLessThanOrEqual(retryAfter(rejected));
    expect(await metricValue(a.container.metrics.rateLimiterFallbackTotal)).toBe(0);
  });

  it('keeps users independent', async () => {
    const exhausted = randomUUID();
    for (let i = 0; i < 50; i += 1) await a.container.drawRateLimiter.consume(exhausted, 'area.create');
    expect((await b.container.drawRateLimiter.consume(exhausted, 'area.create')).allowed).toBe(false);
    const other = await b.container.drawRateLimiter.consume(randomUUID(), 'area.create');
    expect(other).toMatchObject({ allowed: true, remaining: 49 });
  });

  it('slides the window: slots free up one by one as their entries age out, not all at once', async () => {
    // The exact Lua script with a 1 s window and a limit of 3, on the same Redis (the window must be real time).
    const limiter = new RedisDrawRateLimiter({
      redis: a.container.redis.cmd,
      keys: a.container.keys,
      clock: a.container.clock,
      logger: a.container.logger,
      metrics: a.container.metrics,
      limit: 3,
      windowMs: 1000,
    });
    const userId = randomUUID();
    expect((await limiter.consume(userId, 'area.create')).allowed).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect((await limiter.consume(userId, 'area.create')).allowed).toBe(true);
    expect((await limiter.consume(userId, 'area.create')).allowed).toBe(true);
    const full = await limiter.consume(userId, 'area.create');
    // Only the first entry must age out: it is ~ 600 ms from leaving the window.
    expect(retryAfter(full)).toBeGreaterThan(300);
    expect(retryAfter(full)).toBeLessThanOrEqual(600);

    await new Promise((resolve) => setTimeout(resolve, retryAfter(full) + 30));
    const oneSlot = await limiter.consume(userId, 'area.create');
    expect(oneSlot).toMatchObject({ allowed: true, remaining: 0 });
    // The two later entries are still inside the window.
    expect((await limiter.consume(userId, 'area.create')).allowed).toBe(false);
  });
});

describe('draw limiter while the critical Redis is down (section 10.1 degradation)', () => {
  let proxy: TcpProxy;
  let degraded: TestApp;

  beforeAll(async () => {
    proxy = await createTcpProxy(a.config.REDIS_URL);
    degraded = await createTestApp({
      modules: [],
      config: { REDIS_URL: proxy.url, DRAW_RATE_LIMIT_MAX: 3 },
    });
  });

  afterAll(async () => {
    await degraded.close();
    await proxy.close();
  });

  it('enforces the limit in memory, never throws and counts every fallback decision', async () => {
    const userId = randomUUID();
    proxy.pause();
    await waitFor(() => degraded.container.redis.cmd.status !== 'ready', { description: 'cmd client down' });

    const decisions: RateLimitDecision[] = [];
    for (let i = 0; i < 4; i += 1)
      decisions.push(await degraded.container.drawRateLimiter.consume(userId, 'area.create'));
    expect(decisions.map((decision) => decision.allowed)).toEqual([true, true, true, false]);
    const rejected = decisions[3];
    expect(rejected).toBeDefined();
    if (rejected !== undefined) expect(retryAfter(rejected)).toBeGreaterThan(59_000);
    expect(await metricValue(degraded.container.metrics.rateLimiterFallbackTotal)).toBe(4);
    const warnings = degraded.logs.find((line) =>
      String(line.msg).startsWith('Redis draw limiter unavailable'),
    );
    expect(warnings).toHaveLength(1);

    proxy.resume();
    await waitFor(() => degraded.container.redis.cmd.status === 'ready', {
      timeoutMs: 10_000,
      description: 'cmd client reconnected',
    });
    // Back on Redis: the shared window has no entries for this user (the outage decisions were local).
    const recovered = await degraded.container.drawRateLimiter.consume(userId, 'area.create');
    expect(recovered).toMatchObject({ allowed: true, remaining: 2 });
    expect(await metricValue(degraded.container.metrics.rateLimiterFallbackTotal)).toBe(4);
  });
});
