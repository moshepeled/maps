/**
 * Epoch-safe, generation-keyed bbox cache (SPEC section 10.2) against the real critical Redis (generations, epoch) and
 * redis-cache (gzip L2 bodies), with two app instances sharing both. Outages are TCP-proxy pauses and CLIENT KILLs of
 * this run's own connections; the shared services are never touched.
 */
import { randomBytes, randomUUID } from 'node:crypto';
import { gunzipSync } from 'node:zlib';

import type { Bbox } from '@snapland/shared';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { planBboxQuery } from '../../../src/infra/cache/key-plan.js';
import { RedisAreaQueryCache } from '../../../src/infra/cache/redis-area-cache.js';
import type { BboxQueryKey } from '../../../src/infra/cache/types.js';
import { connectionName } from '../../../src/infra/redis/client.js';
import { createRedisAdmin } from '../../helpers/redis-admin.js';
import { createTcpProxy } from '../../helpers/tcp-proxy.js';
import type { TcpProxy } from '../../helpers/tcp-proxy.js';
import { createTestApp } from '../../helpers/test-app.js';
import type { TestApp } from '../../helpers/test-app.js';
import { waitFor } from '../../helpers/wait-for.js';
import { metricValue } from './support/metrics.js';
import { realisticPageBody } from './support/realistic-page.js';

// One place per test, far apart, so one test's invalidations never touch another test's key tiles.
const TEL_AVIV: Bbox = [34.77, 32.07, 34.79, 32.09];
const HAIFA: Bbox = [34.98, 32.79, 35.0, 32.81];
const JERUSALEM: Bbox = [35.2, 31.76, 35.22, 31.78];
const BEER_SHEVA: Bbox = [34.78, 31.24, 34.8, 31.26];
const EILAT: Bbox = [34.94, 29.55, 34.96, 29.57];
const NETANYA: Bbox = [34.85, 32.32, 34.87, 32.34];
const ASHDOD: Bbox = [34.64, 31.79, 34.66, 31.81];
const NAZARETH: Bbox = [35.29, 32.69, 35.31, 32.71];
const ISRAEL_WIDE: Bbox = [34.3, 29.5, 35.9, 33.3];

let a: TestApp;
let b: TestApp;

beforeAll(async () => {
  a = await createTestApp({ modules: [] });
  b = await createTestApp({ modules: [] });
});

afterAll(async () => {
  await Promise.all([a.close(), b.close()]);
});

function cacheOf(app: TestApp): RedisAreaQueryCache {
  const cache = app.container.areaCache;
  if (!(cache instanceof RedisAreaQueryCache)) throw new Error('the production cache is not wired');
  return cache;
}

function keyFor(bbox: Bbox, zoom = 14): BboxQueryKey {
  return { plan: planBboxQuery(bbox, zoom), limit: 2000, cursor: null };
}

/** A loader serving `body` and counting its calls. */
function loaderOf(body: string): { load: () => Promise<string>; calls: () => number } {
  let calls = 0;
  return {
    load: () => {
      calls += 1;
      return Promise.resolve(body);
    },
    calls: () => calls,
  };
}

/** A small bbox inside `outer` (a polygon being edited there). */
function inside(outer: Bbox): Bbox {
  const [west, south, east, north] = outer;
  const midLng = (west + east) / 2;
  const midLat = (south + north) / 2;
  return [midLng, midLat, midLng + 0.0005, midLat + 0.0005];
}

async function epochOf(app: TestApp): Promise<string | null> {
  return app.container.redis.cmd.get(app.container.keys.cacheGenGlobal());
}

describe('bbox cache across instances (section 10.2)', () => {
  it('is the production RedisAreaQueryCache', () => {
    expect(cacheOf(a)).toBeInstanceOf(RedisAreaQueryCache);
  });

  it('never assumes an epoch: without one, the read bypasses and a random epoch is initialised', async () => {
    // Deterministic start whatever ran before in this run (the epoch is shared by the run's prefix).
    await a.container.redis.cmd.del(a.container.keys.cacheGenGlobal());
    const loader = loaderOf('warm-up');
    expect(await cacheOf(a).getOrLoad(keyFor(ASHDOD, 10), loader.load)).toEqual({
      body: 'warm-up',
      outcome: 'bypass',
    });
    expect(Number(await epochOf(a))).toBeGreaterThan(1000);
    expect(await metricValue(a.container.metrics.cacheEpochResetsTotal, { reason: 'missing' })).toBe(1);
    expect((await cacheOf(a).getOrLoad(keyFor(ASHDOD, 10), loader.load)).outcome).toBe('miss');
  });

  it('MISS -> HIT_L1 -> a second instance HIT_L2 (then its own L1)', async () => {
    const key = keyFor(TEL_AVIV);
    const missesBefore = await metricValue(a.container.metrics.cacheRequestsTotal, {
      cache: 'bbox',
      outcome: 'miss',
    });
    const first = loaderOf('tel-aviv-v1');
    expect(await cacheOf(a).getOrLoad(key, first.load)).toEqual({ body: 'tel-aviv-v1', outcome: 'miss' });
    const unused = loaderOf('never');
    expect(await cacheOf(a).getOrLoad(key, unused.load)).toEqual({ body: 'tel-aviv-v1', outcome: 'hit_l1' });
    await cacheOf(a).settled();
    expect(await cacheOf(b).getOrLoad(key, unused.load)).toEqual({ body: 'tel-aviv-v1', outcome: 'hit_l2' });
    expect(await cacheOf(b).getOrLoad(key, unused.load)).toEqual({ body: 'tel-aviv-v1', outcome: 'hit_l1' });
    expect([first.calls(), unused.calls()]).toEqual([1, 0]);
    expect(
      await metricValue(a.container.metrics.cacheRequestsTotal, { cache: 'bbox', outcome: 'miss' }),
    ).toBe(missesBefore + 1);
  });

  it('an overlapping invalidation (by another instance) misses while disjoint tiles still hit', async () => {
    const haifa = keyFor(HAIFA);
    const jerusalem = keyFor(JERUSALEM);
    await cacheOf(a).getOrLoad(haifa, loaderOf('haifa-v1').load);
    await cacheOf(a).getOrLoad(jerusalem, loaderOf('jerusalem-v1').load);

    await cacheOf(b).invalidate([inside(HAIFA)]);

    expect(await cacheOf(a).getOrLoad(haifa, loaderOf('haifa-v2').load)).toEqual({
      body: 'haifa-v2',
      outcome: 'miss',
    });
    expect(await cacheOf(a).getOrLoad(jerusalem, loaderOf('never').load)).toEqual({
      body: 'jerusalem-v1',
      outcome: 'hit_l1',
    });
  });

  it('a polygon that only touches the snapped east edge invalidates the entry', async () => {
    const key = keyFor(BEER_SHEVA);
    await cacheOf(a).getOrLoad(key, loaderOf('beer-sheva-v1').load);
    const [, south, east, north] = key.plan.queryBbox;
    const middle = (south + north) / 2;
    const touching: Bbox = [east, middle, east + 0.001, middle + 0.001];
    // It shares only the edge with the cached page (ST_Intersects is closed, so the page could contain it).
    expect(touching[0]).toBe(key.plan.queryBbox[2]);

    await cacheOf(b).invalidate([touching]);
    expect((await cacheOf(a).getOrLoad(key, loaderOf('beer-sheva-v2').load)).outcome).toBe('miss');
  });

  it('a big polygon bumps the level\'s "big" generation', async () => {
    const key = keyFor(EILAT);
    const level = key.plan.level ?? -1;
    const bigKey = a.container.keys.cacheGenBig(level);
    await cacheOf(a).getOrLoad(key, loaderOf('eilat-v1').load);
    const before = Number((await a.container.redis.cmd.get(bigKey)) ?? 0);

    await cacheOf(b).invalidate([ISRAEL_WIDE]);

    expect(Number(await a.container.redis.cmd.get(bigKey))).toBe(before + 1);
    expect(await a.container.redis.cmd.ttl(bigKey)).toBeGreaterThan(86_000);
    expect((await cacheOf(a).getOrLoad(key, loaderOf('eilat-v2').load)).outcome).toBe('miss');
  });

  it('bypasses at zoom >= 17 (always loads) and caches below', async () => {
    const z17 = loaderOf('z17');
    expect(await cacheOf(a).getOrLoad(keyFor(NETANYA, 17), z17.load)).toEqual({
      body: 'z17',
      outcome: 'bypass',
    });
    expect((await cacheOf(a).getOrLoad(keyFor(NETANYA, 17), z17.load)).outcome).toBe('bypass');
    expect(z17.calls()).toBe(2);
    expect((await cacheOf(a).getOrLoad(keyFor(NETANYA, 16), loaderOf('z16').load)).outcome).toBe('miss');
    expect((await cacheOf(a).getOrLoad(keyFor(NETANYA, 16), loaderOf('z16').load)).outcome).toBe('hit_l1');
  });

  it('reads every generation with ONE MGET per lookup', async () => {
    const mget = vi.spyOn(a.container.redis.cmd, 'mget');
    try {
      const key = keyFor(ASHDOD, 12);
      await cacheOf(a).getOrLoad(key, loaderOf('ashdod').load);
      expect(mget).toHaveBeenCalledTimes(1);
      // epoch + big + every key tile.
      expect(mget.mock.calls[0]?.length).toBe(
        2 + (key.plan.tiles === null ? 0 : tileCountOf(key.plan.tiles)),
      );
      await cacheOf(a).getOrLoad(key, loaderOf('never').load);
      expect(mget).toHaveBeenCalledTimes(2);
    } finally {
      mget.mockRestore();
    }
  });
});

describe('gzip L2 (section 10.2 v1.2)', () => {
  it.each([
    ['z14-like page (6 dp)', { decimals: 6, toleranceM: 4 }],
    ['z12-like page (5 dp)', { decimals: 5, toleranceM: 8 }],
  ])(
    'stores a realistic 2,000-item %s compressed <= 512 KiB; another instance gets HIT_L2',
    async (_name, options) => {
      const body = realisticPageBody(options);
      const raw = Buffer.byteLength(body);
      expect(raw).toBeGreaterThanOrEqual(1.1 * 1024 * 1024);
      expect(raw).toBeLessThanOrEqual(1.4 * 1024 * 1024);
      expect(JSON.parse(body)).toMatchObject({ items: expect.any(Array) as unknown });

      const cacheClient = a.container.redis.cache;
      if (cacheClient === null) throw new Error('the run must configure CACHE_REDIS_URL');
      // Earlier tests' background writes must not be counted by the spy.
      await cacheOf(a).settled();
      const set = vi.spyOn(cacheClient, 'set');
      try {
        const key = keyFor(NAZARETH, options.decimals === 6 ? 14 : 12);
        expect((await cacheOf(a).getOrLoad(key, loaderOf(body).load)).outcome).toBe('miss');
        await cacheOf(a).settled();
        expect(set).toHaveBeenCalledTimes(1);
        const [storedKey, value, mode, ttl] = set.mock.calls[0] ?? [];
        expect(String(storedKey)).toMatch(new RegExp(`^${a.container.keys.prefix}cache:bbox:[0-9a-f]{40}$`));
        expect([mode, ttl]).toEqual(['EX', 120]);
        expect(Buffer.isBuffer(value)).toBe(true);
        const compressed = value as Buffer;
        expect(compressed.byteLength).toBeLessThanOrEqual(512 * 1024);
        expect(gunzipSync(compressed).toString('utf8')).toBe(body);

        const hit = await cacheOf(b).getOrLoad(key, loaderOf('never').load);
        expect(hit.outcome).toBe('hit_l2');
        expect(hit.body).toBe(body);
      } finally {
        set.mockRestore();
      }
    },
  );

  it('never writes a body whose COMPRESSED size exceeds CACHE_L2_MAX_BODY_BYTES', async () => {
    const small = await createTestApp({ modules: [], config: { CACHE_L2_MAX_BODY_BYTES: 1024 } });
    const peer = await createTestApp({ modules: [], config: { CACHE_L2_MAX_BODY_BYTES: 1024 } });
    try {
      const cacheClient = small.container.redis.cache;
      if (cacheClient === null) throw new Error('the run must configure CACHE_REDIS_URL');
      const set = vi.spyOn(cacheClient, 'set');
      // Random bytes do not compress: ~11 KiB of base64 stays far above the 1 KiB cap once gzipped.
      const body = JSON.stringify({ items: [randomBytes(8192).toString('base64')] });
      const key = keyFor(inside(NAZARETH), 10);
      expect((await cacheOf(small).getOrLoad(key, loaderOf(body).load)).outcome).toBe('miss');
      await cacheOf(small).settled();
      expect(set).not.toHaveBeenCalled();
      // Still served from L1 here, but the peer has nothing to read from L2.
      expect((await cacheOf(small).getOrLoad(key, loaderOf('never').load)).outcome).toBe('hit_l1');
      expect((await cacheOf(peer).getOrLoad(key, loaderOf(body).load)).outcome).toBe('miss');
    } finally {
      await Promise.all([small.close(), peer.close()]);
    }
  });
});

describe('degradation (section 10.2 steps 1 and 7, section 10.6)', () => {
  let criticalProxy: TcpProxy;
  let cacheProxy: TcpProxy;
  let behindCritical: TestApp;
  let behindCache: TestApp;

  beforeAll(async () => {
    criticalProxy = await createTcpProxy(a.config.REDIS_URL);
    const cacheUrl = a.config.CACHE_REDIS_URL;
    if (cacheUrl === null) throw new Error('the run must configure CACHE_REDIS_URL');
    cacheProxy = await createTcpProxy(cacheUrl);
    behindCritical = await createTestApp({ modules: [], config: { REDIS_URL: criticalProxy.url } });
    behindCache = await createTestApp({ modules: [], config: { CACHE_REDIS_URL: cacheProxy.url } });
  });

  afterAll(async () => {
    await Promise.all([behindCritical.close(), behindCache.close()]);
    await Promise.all([criticalProxy.close(), cacheProxy.close()]);
  });

  it('critical Redis unreachable -> BYPASS without error; the cache recovers after the outage', async () => {
    const key = keyFor(inside(TEL_AVIV), 13);
    const bumpsBefore = await metricValue(behindCritical.container.metrics.cacheEpochResetsTotal, {
      reason: 'reconnect',
    });
    criticalProxy.pause();
    await waitFor(() => behindCritical.container.redis.cmd.status !== 'ready', { description: 'cmd down' });
    const loader = loaderOf('served-from-db');
    expect(await cacheOf(behindCritical).getOrLoad(key, loader.load)).toEqual({
      body: 'served-from-db',
      outcome: 'bypass',
    });
    expect((await cacheOf(behindCritical).getOrLoad(key, loader.load)).outcome).toBe('bypass');
    expect(loader.calls()).toBe(2);

    criticalProxy.resume();
    // The reconnect owes an epoch bump; reads bypass until it is counted.
    await waitFor(
      async () =>
        (await metricValue(behindCritical.container.metrics.cacheEpochResetsTotal, { reason: 'reconnect' })) >
        bumpsBefore,
      { timeoutMs: 10_000, description: 'cmd reconnected and epoch bumped' },
    );
    expect((await cacheOf(behindCritical).getOrLoad(key, loader.load)).outcome).toBe('miss');
  });

  it('redis-cache unreachable -> MISS then HIT_L1, never an error, and the draw limiter is unaffected', async () => {
    cacheProxy.pause();
    await waitFor(() => behindCache.container.redis.cache?.status !== 'ready', { description: 'cache down' });
    const key = keyFor(inside(JERUSALEM), 13);
    expect(await cacheOf(behindCache).getOrLoad(key, loaderOf('jlm').load)).toEqual({
      body: 'jlm',
      outcome: 'miss',
    });
    await cacheOf(behindCache).settled();
    expect(await cacheOf(behindCache).getOrLoad(key, loaderOf('never').load)).toEqual({
      body: 'jlm',
      outcome: 'hit_l1',
    });
    const decision = await behindCache.container.drawRateLimiter.consume(randomUUID(), 'area.create');
    expect(decision).toMatchObject({ allowed: true, remaining: 49 });
    expect(await metricValue(behindCache.container.metrics.rateLimiterFallbackTotal)).toBe(0);
    cacheProxy.resume();
  });
});

describe('freshness (section 10.2 v1.2: epoch safety)', () => {
  it('(a) a write whose invalidation failed is never hidden by the cache once the writer reconnects', async () => {
    const proxy = await createTcpProxy(a.config.REDIS_URL);
    const writer = await createTestApp({ modules: [], config: { REDIS_URL: proxy.url } });
    try {
      const key = keyFor(inside(BEER_SHEVA), 13);
      expect((await cacheOf(b).getOrLoad(key, loaderOf('before-write').load)).outcome).toBe('miss');
      await cacheOf(b).settled();

      proxy.pause();
      await waitFor(() => writer.container.redis.cmd.status !== 'ready', { description: 'writer cmd down' });
      // The write commits (source of truth changes), then its invalidation cannot reach Redis.
      await cacheOf(writer).invalidate([inside(BEER_SHEVA)]);
      expect(await metricValue(writer.container.metrics.cacheInvalidateFailuresTotal)).toBe(1);

      proxy.resume();
      // The bump owed by the failed invalidation lands once the writer reaches Redis again.
      await waitFor(
        async () =>
          (await metricValue(writer.container.metrics.cacheEpochResetsTotal, {
            reason: 'failed_invalidate',
          })) === 1,
        { timeoutMs: 10_000, description: 'epoch bumped after the writer reconnected' },
      );

      expect(await cacheOf(b).getOrLoad(key, loaderOf('after-write').load)).toEqual({
        body: 'after-write',
        outcome: 'miss',
      });
    } finally {
      await writer.close();
      await proxy.close();
    }
  });

  it('(b) deleted generation keys (simulated Redis restart) -> BYPASS, then MISS under a new epoch', async () => {
    const key = keyFor(inside(HAIFA), 13);
    expect((await cacheOf(a).getOrLoad(key, loaderOf('pre-restart').load)).outcome).toBe('miss');
    await cacheOf(a).settled();
    const oldEpoch = await epochOf(a);
    const missingBefore = await metricValue(a.container.metrics.cacheEpochResetsTotal, { reason: 'missing' });

    const generationKeys = await scanKeys(a, `${a.container.keys.prefix}cache:gen:*`);
    expect(generationKeys.length).toBeGreaterThan(0);
    await a.container.redis.cmd.del(...generationKeys);

    expect(await cacheOf(a).getOrLoad(key, loaderOf('post-restart').load)).toEqual({
      body: 'post-restart',
      outcome: 'bypass',
    });
    const newEpoch = await epochOf(a);
    expect(newEpoch).not.toBeNull();
    expect(newEpoch).not.toBe(oldEpoch);
    expect(Number(newEpoch)).toBeGreaterThan(1000);
    expect(await metricValue(a.container.metrics.cacheEpochResetsTotal, { reason: 'missing' })).toBe(
      missingBefore + 1,
    );

    // Neither instance can reach the body cached under the old epoch (L1 or L2).
    expect(await cacheOf(a).getOrLoad(key, loaderOf('post-restart').load)).toEqual({
      body: 'post-restart',
      outcome: 'miss',
    });
    const peer = await cacheOf(b).getOrLoad(key, loaderOf('post-restart').load);
    expect(peer.body).toBe('post-restart');
  });

  it('(c) CLIENT KILL of the cmd client -> the epoch is bumped and the cached page is unreachable', async () => {
    const key = keyFor(inside(NETANYA), 13);
    await cacheOf(a).getOrLoad(key, loaderOf('before-kill').load);
    expect((await cacheOf(a).getOrLoad(key, loaderOf('never').load)).outcome).toBe('hit_l1');
    const epoch = await epochOf(a);
    const resetsBefore = await metricValue(a.container.metrics.cacheEpochResetsTotal, {
      reason: 'reconnect',
    });

    const admin = createRedisAdmin();
    try {
      expect(await admin.killClientByName(connectionName('cmd', a.container.instanceId))).toBe(1);
    } finally {
      await admin.close();
    }

    await waitFor(
      async () =>
        (await metricValue(a.container.metrics.cacheEpochResetsTotal, { reason: 'reconnect' })) ===
        resetsBefore + 1,
      { timeoutMs: 10_000, description: 'epoch bumped after the reconnect' },
    );
    expect(await epochOf(a)).toBe(String(Number(epoch) + 1));
    expect(await cacheOf(a).getOrLoad(key, loaderOf('after-kill').load)).toEqual({
      body: 'after-kill',
      outcome: 'miss',
    });
  });
});

function tileCountOf(tiles: { minX: number; maxX: number; minY: number; maxY: number }): number {
  return (tiles.maxX - tiles.minX + 1) * (tiles.maxY - tiles.minY + 1);
}

async function scanKeys(app: TestApp, pattern: string): Promise<string[]> {
  const found: string[] = [];
  let cursor = '0';
  do {
    const [next, keys] = await app.container.redis.cmd.scan(cursor, 'MATCH', pattern, 'COUNT', 500);
    cursor = next;
    found.push(...keys);
  } while (cursor !== '0');
  return found;
}
