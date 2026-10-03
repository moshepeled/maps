/**
 * Epoch-safe, generation-keyed bbox query cache (SPEC section 10.2): L1 in process (lru-cache, bounded by entries and bytes),
 * L2 on the separate `redis-cache` instance (gzip bodies), generation counters and the random global epoch on the
 * critical `redis` (`cmd` client, never evicted).
 *
 * Read path: one MGET of [epoch, big, tiles...] -> cache key embeds all of them -> L1 -> L2 -> loader -> L2 (background) + L1.
 * Correctness hinges on three rules:
 *  - a missing epoch (fresh or restarted Redis, deleted key) means "bypass and SET NX a random epoch", so bodies cached
 *    under an earlier epoch can never be matched again even though per-tile generations restart at 0;
 *  - a failed invalidation clears L1, bypasses this instance's cache and bumps the epoch as soon as Redis answers again
 *    (1 s retry + the cmd client's `ready` event);
 *  - any reconnect of the cmd client after an error or a dropped connection bumps the epoch and clears L1, because a
 *    write committed while this instance could not reach Redis may have been invalidated nowhere.
 * The critical Redis being down means BYPASS (served from the DB, never an error); `redis-cache` being down only skips L2.
 */
import type { Bbox } from '@snapland/shared';
import type { Redis } from 'ioredis';
import { LRUCache } from 'lru-cache';

import type { Clock } from '../clock.js';
import { KeyedThrottle } from '../keyed-throttle.js';
import { runDetached } from '../lifecycle.js';
import type { Lifecycle } from '../lifecycle.js';
import type { Logger } from '../logger.js';
import type { Metrics } from '../metrics/metrics.js';
import type { RedisKeys } from '../redis/keys.js';
import { LuaScript } from '../redis/lua.js';
import { cacheKeyHash, keyTiles, randomEpoch, tilesToInvalidate } from './key-plan.js';
import type { GenerationSnapshot } from './key-plan.js';
import { decodeL2Body, encodeL2Body } from './l2-codec.js';
import type { AreaQueryCache, BboxQueryKey, BboxQueryPlan, CacheOutcome } from './types.js';

/** L1 byte bound (section 10.2: 500 entries / 50 MiB). */
const L1_MAX_BYTES = 50 * 1024 * 1024;
/** Generation keys expire after 24 h idle - far longer than any cached value lives (section 10.2 step 6). */
const GENERATION_TTL_S = 86_400;
/** Retry period of a pending epoch bump (section 10.2 step 5). */
const EPOCH_RETRY_INTERVAL_MS = 1000;
/** Background L2 writes in flight at most; beyond it a write is skipped (bounded memory while redis-cache hangs). */
const MAX_PENDING_L2_WRITES = 32;
const WARN_INTERVAL_MS = 10_000;

/** INCR + EXPIRE of every generation key of one invalidation, atomically (<= 240 keys per bbox, section 10.2 step 5). */
const INVALIDATE = new LuaScript(`
for i = 1, #KEYS do
  redis.call('INCR', KEYS[i])
  redis.call('EXPIRE', KEYS[i], ARGV[1])
end
return #KEYS
`);

/**
 * Epoch bump that never makes the epoch small: INCR when it exists, else a fresh random value (the same rule as the
 * reader's SET NX), so a bump racing a Redis restart cannot recreate an epoch value used in an earlier life.
 */
const BUMP_EPOCH = new LuaScript(`
if redis.call('EXISTS', KEYS[1]) == 1 then
  return redis.call('INCR', KEYS[1])
end
redis.call('SET', KEYS[1], ARGV[1])
return tonumber(ARGV[1])
`);

type EpochResetReason = 'missing' | 'reconnect' | 'failed_invalidate';

interface L1Entry {
  body: string;
  bytes: number;
}

export interface RedisAreaQueryCacheOptions {
  /** Critical Redis: generations and epoch. */
  cmd: Redis;
  /** `redis-cache` for L2 bodies; null disables L2. */
  cache: Redis | null;
  keys: RedisKeys;
  metrics: Pick<Metrics, 'cacheRequestsTotal' | 'cacheInvalidateFailuresTotal' | 'cacheEpochResetsTotal'>;
  logger: Logger;
  clock: Clock;
  /** CACHE_ENABLED: false -> every read bypasses (invalidations still run for instances that cache). */
  enabled: boolean;
  l1MaxEntries: number;
  l1TtlMs: number;
  /** CACHE_L1_MAX_ENTRY_BYTES: larger bodies are served but not kept in L1. */
  l1MaxEntryBytes: number;
  /** CACHE_BBOX_TTL_S */
  l2TtlS: number;
  /** CACHE_L2_MAX_BODY_BYTES: cap of the gzip-compressed body. */
  l2MaxBodyBytes: number;
}

/** Every generation key one invalidation must bump, deduplicated across the bboxes (old and new bbox of a write). */
function generationKeysFor(bboxes: readonly Bbox[], keys: RedisKeys): string[] {
  const unique = new Set<string>();
  for (const bbox of bboxes) {
    for (const { level, tiles } of tilesToInvalidate(bbox)) {
      if (tiles === 'big') {
        unique.add(keys.cacheGenBig(level));
        continue;
      }
      for (let y = tiles.minY; y <= tiles.maxY; y += 1) {
        for (let x = tiles.minX; x <= tiles.maxX; x += 1) unique.add(keys.cacheGenTile(level, x, y));
      }
    }
  }
  return [...unique];
}

export class RedisAreaQueryCache implements AreaQueryCache, Lifecycle {
  readonly #options: RedisAreaQueryCacheOptions;
  readonly #logger: Logger;
  readonly #l1: LRUCache<string, L1Entry>;
  readonly #pendingWrites = new Set<Promise<void>>();
  readonly #warnings = new KeyedThrottle(WARN_INTERVAL_MS);
  /** Set when an epoch bump is owed (failed invalidation, or reconnect); reads bypass until it lands. */
  #pendingBump: EpochResetReason | null = null;
  #bumping = false;
  /** The cmd client dropped or errored since its last `ready`: the next `ready` owes an epoch bump. */
  #reconnectOwesBump = false;
  #retryTimer: NodeJS.Timeout | undefined;
  #detach: (() => void) | undefined;
  #closed = false;
  #closing: Promise<void> | undefined;

  constructor(options: RedisAreaQueryCacheOptions) {
    this.#options = options;
    this.#logger = options.logger.child({ component: 'area-cache' });
    this.#l1 = new LRUCache<string, L1Entry>({
      max: options.l1MaxEntries,
      maxSize: L1_MAX_BYTES,
      maxEntrySize: options.l1MaxEntryBytes,
      sizeCalculation: (entry) => Math.max(1, entry.bytes),
      ttl: options.l1TtlMs,
    });
  }

  /** Subscribes to the cmd client's connection events (epoch bumps after a reconnect). */
  start(): void {
    if (this.#detach !== undefined || this.#closed) return;
    const { cmd } = this.#options;
    const onReady = (): void => {
      if (this.#reconnectOwesBump) {
        this.#reconnectOwesBump = false;
        this.#pendingBump ??= 'reconnect';
      }
      if (this.#pendingBump !== null) runDetached(this.#tryBump(), this.#logger, 'cache epoch bump');
    };
    const onDisconnect = (): void => {
      this.#reconnectOwesBump = true;
    };
    // `close` fires on every dropped connection (CLIENT KILL, network loss); `error` also covers a failed first connect.
    cmd.on('ready', onReady);
    cmd.on('error', onDisconnect);
    cmd.on('close', onDisconnect);
    this.#detach = () => {
      cmd.off('ready', onReady);
      cmd.off('error', onDisconnect);
      cmd.off('close', onDisconnect);
    };
  }

  async getOrLoad(
    key: BboxQueryKey,
    loader: () => Promise<string>,
  ): Promise<{ body: string; outcome: CacheOutcome }> {
    if (!this.#options.enabled || key.plan.level === null || this.#pendingBump !== null) {
      return this.#record(await loader(), 'bypass');
    }
    const generations = await this.#readGenerations(key.plan, key.plan.level);
    if (generations === null) return this.#record(await loader(), 'bypass');

    const hash = cacheKeyHash(key, generations);
    const l1 = this.#l1.get(hash);
    if (l1 !== undefined) return this.#record(l1.body, 'hit_l1');

    const fromL2 = await this.#readL2(hash);
    if (fromL2 !== null) {
      this.#storeL1(hash, fromL2);
      return this.#record(fromL2, 'hit_l2');
    }

    const body = await loader();
    this.#storeL1(hash, body);
    this.#scheduleL2Write(hash, body);
    return this.#record(body, 'miss');
  }

  async invalidate(bboxes: readonly Bbox[]): Promise<void> {
    if (bboxes.length === 0) return;
    const { cmd } = this.#options;
    try {
      if (cmd.status !== 'ready') throw new Error(`critical Redis not ready (${cmd.status})`);
      await INVALIDATE.run(cmd, generationKeysFor(bboxes, this.#options.keys), [GENERATION_TTL_S]);
    } catch (error) {
      this.#onInvalidateFailure(error);
    }
  }

  /** Resolves once every background L2 write started so far has settled (tests, shutdown). */
  async settled(): Promise<void> {
    while (this.#pendingWrites.size > 0) await Promise.allSettled([...this.#pendingWrites]);
  }

  close(): Promise<void> {
    this.#closing ??= this.#shutdown();
    return this.#closing;
  }

  async #shutdown(): Promise<void> {
    this.#closed = true;
    this.#detach?.();
    this.#detach = undefined;
    this.#stopRetryTimer();
    // Writes are bounded by the cache client's command timeout, so this cannot hang the shutdown.
    await this.settled();
    this.#l1.clear();
  }

  /** One MGET of [epoch, big, tiles...]; null means "bypass" (Redis down or a missing epoch). */
  async #readGenerations(plan: BboxQueryPlan, level: number): Promise<GenerationSnapshot | null> {
    const { cmd, keys } = this.#options;
    if (cmd.status !== 'ready') return null;
    const tiles = keyTiles(plan);
    let values: (string | null)[];
    try {
      values = await cmd.mget(
        keys.cacheGenGlobal(),
        keys.cacheGenBig(level),
        ...tiles.map((tile) => keys.cacheGenTile(level, tile.x, tile.y)),
      );
    } catch (error) {
      this.#warn('generations', error, 'bbox cache bypassed: generations could not be read');
      return null;
    }
    const [epoch, big, ...tileValues] = values;
    if (epoch === null || epoch === undefined) {
      await this.#initEpoch();
      return null;
    }
    // A missing counter reads as 0 (the key was never bumped or expired idle, section 10.2 step 6).
    return { epoch, big: Number(big ?? 0), tiles: tileValues.map((value) => Number(value ?? 0)) };
  }

  /** `SET gen:global <random 52-bit> NX`: only one instance's value wins; everyone reads it next time. */
  async #initEpoch(): Promise<void> {
    const { cmd, keys } = this.#options;
    try {
      const reply = await cmd.set(keys.cacheGenGlobal(), randomEpoch(), 'NX');
      if (reply === 'OK') {
        this.#l1.clear();
        this.#options.metrics.cacheEpochResetsTotal.inc({ reason: 'missing' });
        this.#logger.info('bbox cache epoch was missing: initialised a new random epoch');
      }
    } catch (error) {
      this.#warn('epoch-init', error, 'bbox cache epoch could not be initialised');
    }
  }

  async #readL2(hash: string): Promise<string | null> {
    const { cache, keys } = this.#options;
    if (cache?.status !== 'ready') return null;
    try {
      const value = await cache.getBuffer(keys.cacheBody(hash));
      return value === null ? null : await decodeL2Body(value);
    } catch (error) {
      // redis-cache is disposable (section 10.2 step 7): a failure is a miss, never an error.
      this.#warn('l2-read', error, 'L2 read failed; treating as a miss');
      return null;
    }
  }

  #scheduleL2Write(hash: string, body: string): void {
    if (this.#options.cache === null || this.#closed) return;
    if (this.#pendingWrites.size >= MAX_PENDING_L2_WRITES) {
      this.#logger.debug('L2 write skipped: too many writes in flight');
      return;
    }
    const write: Promise<void> = this.#writeL2(hash, body).finally(() => {
      this.#pendingWrites.delete(write);
    });
    this.#pendingWrites.add(write);
  }

  async #writeL2(hash: string, body: string): Promise<void> {
    const { cache, keys, l2MaxBodyBytes, l2TtlS } = this.#options;
    try {
      const compressed = await encodeL2Body(body, l2MaxBodyBytes);
      if (compressed === null) {
        this.#logger.debug(
          { bytes: Buffer.byteLength(body) },
          'body too large for L2 even compressed; L1 only',
        );
        return;
      }
      if (cache?.status !== 'ready') return;
      await cache.set(keys.cacheBody(hash), compressed, 'EX', l2TtlS);
    } catch (error) {
      this.#warn('l2-write', error, 'L2 write failed; the body stays L1-only');
    }
  }

  #storeL1(hash: string, body: string): void {
    const bytes = Buffer.byteLength(body);
    if (bytes > this.#options.l1MaxEntryBytes) return;
    this.#l1.set(hash, { body, bytes });
  }

  #onInvalidateFailure(error: unknown): void {
    this.#options.metrics.cacheInvalidateFailuresTotal.inc();
    this.#l1.clear();
    this.#pendingBump = 'failed_invalidate';
    this.#warn('invalidate', error, 'bbox cache invalidation failed: L1 cleared, epoch bump scheduled');
    this.#ensureRetryTimer();
  }

  #ensureRetryTimer(): void {
    if (this.#retryTimer !== undefined || this.#closed) return;
    this.#retryTimer = setInterval(() => {
      runDetached(this.#tryBump(), this.#logger, 'cache epoch bump retry');
    }, EPOCH_RETRY_INTERVAL_MS);
    this.#retryTimer.unref();
  }

  #stopRetryTimer(): void {
    if (this.#retryTimer === undefined) return;
    clearInterval(this.#retryTimer);
    this.#retryTimer = undefined;
  }

  /** Bumps the epoch if one is owed and Redis answers; on failure the 1 s timer keeps retrying. */
  async #tryBump(): Promise<void> {
    const reason = this.#pendingBump;
    const { cmd, keys } = this.#options;
    if (reason === null) {
      this.#stopRetryTimer();
      return;
    }
    if (this.#bumping || this.#closed) return;
    if (cmd.status !== 'ready') {
      this.#ensureRetryTimer();
      return;
    }
    this.#bumping = true;
    try {
      await BUMP_EPOCH.run(cmd, [keys.cacheGenGlobal()], [randomEpoch()]);
      this.#l1.clear();
      this.#pendingBump = null;
      this.#stopRetryTimer();
      this.#options.metrics.cacheEpochResetsTotal.inc({ reason });
      this.#logger.info({ reason }, 'bbox cache epoch bumped: every previously cached page is unreachable');
    } catch (error) {
      this.#warn('bump', error, 'bbox cache epoch bump failed; retrying');
      this.#ensureRetryTimer();
    } finally {
      this.#bumping = false;
    }
  }

  #warn(category: string, error: unknown, message: string): void {
    if (!this.#warnings.shouldFire(category, this.#options.clock.now())) return;
    this.#logger.warn({ err: error }, message);
  }

  #record(body: string, outcome: CacheOutcome): { body: string; outcome: CacheOutcome } {
    this.#options.metrics.cacheRequestsTotal.inc({ cache: 'bbox', outcome });
    return { body, outcome };
  }
}
