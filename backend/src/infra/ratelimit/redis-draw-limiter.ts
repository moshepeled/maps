/**
 * Drawing-action limiter (SPEC section 10.1, ADR-0008): 50 actions per rolling 60 s per user, shared by REST, WS and every
 * instance through ONE atomic Lua sliding-window log in Redis. The clock is Redis `TIME`, so instance clock skew
 * cannot move the window, and a rejection is not recorded (rejected actions do not consume budget).
 *
 * Availability over strictness: when Redis errors or times out (the fail-fast `cmd` client has no offline queue), the
 * decision comes from an in-process window with identical semantics instead of failing the request. During an outage
 * the effective limit is therefore 50 x instances per user (the documented trade-off). Every fallback decision is
 * counted; the warning is logged at most once per 30 s.
 */
import { randomUUID } from 'node:crypto';

import type { Redis } from 'ioredis';

import type { Clock } from '../clock.js';
import { KeyedThrottle } from '../keyed-throttle.js';
import type { Logger } from '../logger.js';
import type { Metrics } from '../metrics/metrics.js';
import type { RedisKeys } from '../redis/keys.js';
import { LuaScript } from '../redis/lua.js';
import { InMemoryDrawRateLimiter } from './in-memory.js';
import type { DrawActionKind, DrawRateLimiter, RateLimitDecision } from './types.js';

/**
 * KEYS[1] = <p>rl:draw:<userId>; ARGV[1] = limit; ARGV[2] = windowMs; ARGV[3] = unique member (uuid).
 * Returns {allowed, remaining, msUntilOldestExpires} - the exact script of section 10.1.
 */
const SLIDING_WINDOW = new LuaScript(`
local t = redis.call('TIME')
local now = tonumber(t[1]) * 1000 + math.floor(tonumber(t[2]) / 1000)
local limit, window = tonumber(ARGV[1]), tonumber(ARGV[2])
redis.call('ZREMRANGEBYSCORE', KEYS[1], '-inf', now - window)
local count = redis.call('ZCARD', KEYS[1])
if count < limit then
  redis.call('ZADD', KEYS[1], now, ARGV[3])
  redis.call('PEXPIRE', KEYS[1], window)
  local oldest = redis.call('ZRANGE', KEYS[1], 0, 0, 'WITHSCORES')
  return {1, limit - count - 1, tonumber(oldest[2]) + window - now}
end
local oldest = redis.call('ZRANGE', KEYS[1], 0, 0, 'WITHSCORES')
return {0, 0, tonumber(oldest[2]) + window - now}
`);

/** Minimum time between two "Redis limiter unavailable" warnings. */
const FALLBACK_WARN_INTERVAL_MS = 30_000;

export interface RedisDrawRateLimiterOptions {
  redis: Redis;
  keys: RedisKeys;
  clock: Clock;
  logger: Logger;
  metrics: Pick<Metrics, 'rateLimiterFallbackTotal'>;
  limit: number;
  windowMs: number;
}

export class RedisDrawRateLimiter implements DrawRateLimiter {
  readonly #options: RedisDrawRateLimiterOptions;
  readonly #logger: Logger;
  readonly #fallback: InMemoryDrawRateLimiter;
  readonly #warnings = new KeyedThrottle(FALLBACK_WARN_INTERVAL_MS);

  constructor(options: RedisDrawRateLimiterOptions) {
    this.#options = options;
    this.#logger = options.logger.child({ component: 'draw-rate-limiter' });
    const { limit, windowMs, clock } = options;
    this.#fallback = new InMemoryDrawRateLimiter({ limit, windowMs, clock });
  }

  async consume(userId: string, kind: DrawActionKind): Promise<RateLimitDecision> {
    try {
      return await this.#consumeShared(userId);
    } catch (error) {
      this.#options.metrics.rateLimiterFallbackTotal.inc();
      if (this.#warnings.shouldFire('redis', this.#options.clock.now())) {
        this.#logger.warn(
          { err: error },
          'Redis draw limiter unavailable: deciding with the in-process fallback (limit is per instance until Redis recovers)',
        );
      }
      return this.#fallback.consume(userId, kind);
    }
  }

  async #consumeShared(userId: string): Promise<RateLimitDecision> {
    const { redis, keys, clock, limit, windowMs } = this.#options;
    const reply = await SLIDING_WINDOW.run(
      redis,
      [keys.drawLimiter(userId)],
      [limit, windowMs, randomUUID()],
    );
    if (!Array.isArray(reply) || reply.length !== 3)
      throw new Error('draw limiter: unexpected Lua reply shape');
    const allowed = Number(reply[0]) === 1;
    const remaining = Number(reply[1]);
    const msUntilOldestExpires = Math.max(0, Number(reply[2]));
    // Reset is expressed on this instance's clock (headers are relative seconds, so skew only shifts by the RTT).
    const resetAtMs = clock.now() + msUntilOldestExpires;
    if (allowed) return { allowed: true, limit, remaining, resetAtMs };
    return { allowed: false, limit, remaining: 0, retryAfterMs: msUntilOldestExpires, resetAtMs };
  }
}
