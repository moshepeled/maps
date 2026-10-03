/**
 * Inbound throttling primitives (SPEC section 7.8), pure and clock-driven: a token bucket (40 burst, 20 tokens/s per
 * connection) and a bounded sliding-window counter used for flood (4429) and invalid-message (4400) detection.
 */

export interface TokenBucketOptions {
  /** Maximum burst (bucket size). */
  capacity: number;
  /** Tokens added per second, continuously. */
  refillPerSecond: number;
}

export class TokenBucket {
  readonly #capacity: number;
  readonly #refillPerMs: number;
  #tokens: number;
  #updatedAt: number;

  constructor({ capacity, refillPerSecond }: TokenBucketOptions, now: number) {
    this.#capacity = capacity;
    this.#refillPerMs = refillPerSecond / 1000;
    this.#tokens = capacity;
    this.#updatedAt = now;
  }

  /** Takes one token when available; false means the message must be throttled. */
  tryTake(now: number): boolean {
    // A clock that moves backwards (NTP step) must not drain the bucket.
    const elapsed = Math.max(0, now - this.#updatedAt);
    this.#tokens = Math.min(this.#capacity, this.#tokens + elapsed * this.#refillPerMs);
    this.#updatedAt = now;
    if (this.#tokens < 1) return false;
    this.#tokens -= 1;
    return true;
  }
}

/**
 * Counts events in a sliding window. `hit()` records one event and reports whether MORE than `limit` events happened
 * within the last `windowMs` (so with limit 20 the 21st event inside the window returns true). Memory is bounded to
 * `limit + 1` timestamps: only the most recent ones can decide whether the limit is exceeded.
 */
export class WindowCounter {
  readonly #limit: number;
  readonly #windowMs: number;
  readonly #timestamps: number[] = [];

  constructor(limit: number, windowMs: number) {
    this.#limit = limit;
    this.#windowMs = windowMs;
  }

  hit(now: number): boolean {
    this.#timestamps.push(now);
    this.#evict(now);
    if (this.#timestamps.length > this.#limit + 1) this.#timestamps.shift();
    return this.#timestamps.length > this.#limit;
  }

  /** Events currently inside the window. */
  count(now: number): number {
    this.#evict(now);
    return this.#timestamps.length;
  }

  #evict(now: number): void {
    const cutoff = now - this.#windowMs;
    while (this.#timestamps.length > 0 && (this.#timestamps[0] ?? now) <= cutoff) this.#timestamps.shift();
  }
}
