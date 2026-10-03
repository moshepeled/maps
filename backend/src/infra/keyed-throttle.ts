/**
 * At most one event per key per interval, in a bounded map (registry TTL refreshes, throttled warning logs). The least
 * recently accepted key is forgotten first when the bound is reached.
 */
export class KeyedThrottle {
  readonly #lastFired = new Map<string, number>();
  readonly #intervalMs: number;
  readonly #maxEntries: number;

  constructor(intervalMs: number, maxEntries = 10_000) {
    this.#intervalMs = intervalMs;
    this.#maxEntries = maxEntries;
  }

  /** True when the key may fire now (and records it). */
  shouldFire(key: string, now: number): boolean {
    const last = this.#lastFired.get(key);
    if (last !== undefined && now - last < this.#intervalMs) return false;
    this.#lastFired.delete(key);
    this.#lastFired.set(key, now);
    if (this.#lastFired.size > this.#maxEntries) {
      // Maps iterate in insertion order: the first key is the least recently accepted one.
      const oldest = this.#lastFired.keys().next();
      if (oldest.done !== true) this.#lastFired.delete(oldest.value);
    }
    return true;
  }

  forget(key: string): void {
    this.#lastFired.delete(key);
  }
}
