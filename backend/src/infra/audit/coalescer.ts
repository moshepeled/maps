/**
 * Coalescing of high-frequency denials (SPEC section 3.3, section 10.1, section 10.4): per key, the first event of a window is written at
 * once with `details.count = 1`; later events of the window only increment a counter, written as ONE row with
 * `details.count = <later hits>` when the window closes. A flood therefore produces a bounded number of rows and can no
 * longer push everyone else's events out of the audit queue. The key map is bounded (oldest window flushed early).
 */
import type { Clock } from '../clock.js';
import type { Lifecycle } from '../lifecycle.js';
import type { AuditCoalescer, AuditEvent, AuditLogger } from './types.js';

const COALESCE_WINDOW_MS = 10_000;
const COALESCE_MAX_KEYS = 10_000;
/** How often closed windows are swept (their counters written). */
const SWEEP_INTERVAL_MS = 1000;

interface WindowState {
  windowEnd: number;
  /** Hits after the first one. */
  laterHits: number;
  /** The most recent event of the window (its fields describe the aggregated row). */
  latest: AuditEvent;
}

export interface WindowedAuditCoalescerOptions {
  sink: AuditLogger;
  clock: Clock;
  maxKeys?: number;
}

export class WindowedAuditCoalescer implements AuditCoalescer, Lifecycle {
  readonly #sink: AuditLogger;
  readonly #clock: Clock;
  readonly #maxKeys: number;
  readonly #windows = new Map<string, WindowState>();
  #timer: NodeJS.Timeout | undefined;

  constructor({ sink, clock, maxKeys = COALESCE_MAX_KEYS }: WindowedAuditCoalescerOptions) {
    this.#sink = sink;
    this.#clock = clock;
    this.#maxKeys = maxKeys;
  }

  start(): void {
    if (this.#timer !== undefined) return;
    this.#timer = setInterval(() => {
      this.sweep();
    }, SWEEP_INTERVAL_MS);
    this.#timer.unref();
  }

  record(key: string, event: AuditEvent): void {
    const now = this.#clock.now();
    const current = this.#windows.get(key);
    if (current !== undefined && now < current.windowEnd) {
      current.laterHits += 1;
      current.latest = event;
      return;
    }
    if (current !== undefined) this.#close(key, current);
    this.#sink.record(withCount(event, 1));
    this.#windows.set(key, { windowEnd: now + COALESCE_WINDOW_MS, laterHits: 0, latest: event });
    this.#enforceBound();
  }

  /** Writes the counters of every window that has closed. */
  sweep(): void {
    const now = this.#clock.now();
    for (const [key, state] of this.#windows) {
      if (now >= state.windowEnd) this.#close(key, state);
    }
  }

  /** Writes every pending counter now (shutdown). */
  flush(): Promise<void> {
    for (const [key, state] of this.#windows) this.#close(key, state);
    return Promise.resolve();
  }

  async close(): Promise<void> {
    if (this.#timer !== undefined) {
      clearInterval(this.#timer);
      this.#timer = undefined;
    }
    await this.flush();
  }

  #close(key: string, state: WindowState): void {
    this.#windows.delete(key);
    if (state.laterHits > 0) this.#sink.record(withCount(state.latest, state.laterHits));
  }

  #enforceBound(): void {
    while (this.#windows.size > this.#maxKeys) {
      const oldest = this.#windows.entries().next();
      if (oldest.done === true) return;
      const [key, state] = oldest.value;
      this.#close(key, state);
    }
  }
}

function withCount(event: AuditEvent, count: number): AuditEvent {
  return { ...event, details: { ...event.details, count } };
}
