/**
 * Per-draft coalescing (SPEC section 7.6, section 10.11), pure apart from the unref'd timers:
 *  - `push(state)` keeps only the latest state and publishes it once `coalesceMs` after the first pending push
 *    (trailing), so a 10 Hz stream costs at most one bus publish per window;
 *  - after every publish a keyframe timer re-publishes the latest state every `keyframeMs` while nothing else was
 *    published (late joiners see an idle draft);
 *  - `cancel()` discards a pending trailing state (it is NOT flushed) and stops the keyframes. The draft service calls
 *    it before publishing `draft.ended`, so this instance never emits a `draft.updated` after the end of the same draft.
 */
import { unrefTimeout } from './timers.js';
import type { Cancel } from './timers.js';

export interface DraftCoalescerOptions<T> {
  coalesceMs: number;
  keyframeMs: number;
  publish: (state: T) => void;
}

export class DraftCoalescer<T> {
  readonly #options: DraftCoalescerOptions<T>;
  #latest: T | null = null;
  #trailing: Cancel | null = null;
  #keyframe: Cancel | null = null;
  #cancelled = false;

  constructor(options: DraftCoalescerOptions<T>) {
    this.#options = options;
  }

  /** The most recent state (published or pending). */
  get latest(): T | null {
    return this.#latest;
  }

  /** Publishes `state` at once (the rev-0 announcement of draft.start), replacing anything pending. */
  publishNow(state: T): void {
    if (this.#cancelled) return;
    this.#latest = state;
    this.#clearTrailing();
    this.#publish();
  }

  /** Records the latest state; it is published `coalesceMs` after the first push of the window. */
  push(state: T): void {
    if (this.#cancelled) return;
    this.#latest = state;
    if (this.#trailing !== null) return;
    this.#trailing = unrefTimeout(() => {
      this.#trailing = null;
      this.#publish();
    }, this.#options.coalesceMs);
  }

  /** Discards the pending state and stops the keyframes; the coalescer is unusable afterwards. Idempotent. */
  cancel(): void {
    this.#cancelled = true;
    this.#clearTrailing();
    this.#keyframe?.();
    this.#keyframe = null;
  }

  #publish(): void {
    const state = this.#latest;
    if (this.#cancelled || state === null) return;
    this.#options.publish(state);
    this.#keyframe?.();
    this.#keyframe = unrefTimeout(() => {
      this.#keyframe = null;
      this.#publish();
    }, this.#options.keyframeMs);
  }

  #clearTrailing(): void {
    this.#trailing?.();
    this.#trailing = null;
  }
}
