/**
 * Exact sliding-window log in process memory (SPEC section 10.1): the semantics of the Redis Lua script - an action is
 * allowed while fewer than `limit` actions happened in the last `windowMs`; a rejection is not recorded. Used by unit
 * tests, by tests that must not depend on Redis, and as the fallback of the Redis limiter (bounded to 10,000 users,
 * least recently used evicted first).
 */
import type { Clock } from '../clock.js';
import type { DrawActionKind, DrawRateLimiter, RateLimitDecision } from './types.js';

export interface InMemoryDrawRateLimiterOptions {
  limit: number;
  windowMs: number;
  clock: Clock;
  /** Users tracked at most (the least recently active one is evicted). */
  maxUsers?: number;
}

export class InMemoryDrawRateLimiter implements DrawRateLimiter {
  readonly #windows = new Map<string, number[]>();
  readonly #limit: number;
  readonly #windowMs: number;
  readonly #clock: Clock;
  readonly #maxUsers: number;

  constructor({ limit, windowMs, clock, maxUsers = 10_000 }: InMemoryDrawRateLimiterOptions) {
    this.#limit = limit;
    this.#windowMs = windowMs;
    this.#clock = clock;
    this.#maxUsers = maxUsers;
  }

  consume(userId: string, _kind: DrawActionKind): Promise<RateLimitDecision> {
    const now = this.#clock.now();
    // Same boundary as ZREMRANGEBYSCORE -inf (now - window): an entry exactly one window old has left it.
    const window = (this.#windows.get(userId) ?? []).filter((timestamp) => timestamp > now - this.#windowMs);
    this.#touch(userId, window);

    if (window.length < this.#limit) {
      window.push(now);
      const oldest = window[0] ?? now;
      return Promise.resolve({
        allowed: true,
        limit: this.#limit,
        remaining: this.#limit - window.length,
        resetAtMs: oldest + this.#windowMs,
      });
    }
    const oldest = window[0] ?? now;
    const resetAtMs = oldest + this.#windowMs;
    return Promise.resolve({
      allowed: false,
      limit: this.#limit,
      remaining: 0,
      retryAfterMs: resetAtMs - now,
      resetAtMs,
    });
  }

  /** Re-inserts the user as most recently used and evicts beyond the bound. */
  #touch(userId: string, window: number[]): void {
    this.#windows.delete(userId);
    this.#windows.set(userId, window);
    if (this.#windows.size > this.#maxUsers) {
      const oldest = this.#windows.keys().next();
      if (oldest.done !== true) this.#windows.delete(oldest.value);
    }
  }
}
