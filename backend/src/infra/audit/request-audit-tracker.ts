/**
 * Lets the generic onResponse audit hook know whether a request was already audited (SPEC section 3.3, section 10.4). `container.audit`
 * is a thin wrapper around the configured AuditLogger that marks `event.requestId` here, so services keep calling
 * `container.audit.record()` unchanged and the hook only writes a failure row when nothing else did.
 *
 * Request ids are client-controlled, so entries count the overlapping requests that share an id: a mark is trusted
 * only while one request holds the id, and one request's release never clears another's mark.
 */
import type { Clock } from '../clock.js';
import type { Lifecycle } from '../lifecycle.js';
import type { AuditEvent, AuditLogger, RequestAuditTracker } from './types.js';

export const TRACKER_ENTRY_TTL_MS = 60_000;
export const TRACKER_MAX_ENTRIES = 10_000;

interface TrackerEntry {
  /** Requests with this id between `begin` (onRequest) and `release` (onResponse). */
  inFlight: number;
  /** Set once two requests with this id overlapped; cleared when the last of them is released. */
  shared: boolean;
  /** When an audit event with this id was last recorded; undefined while none was. */
  markedAt: number | undefined;
  /** Last begin/mark, for the TTL (aborted requests may never be released). */
  touchedAt: number;
}

export class InMemoryRequestAuditTracker implements RequestAuditTracker {
  /** requestId -> entry, re-inserted on every touch (insertion order = age order, which makes eviction O(1)). */
  readonly #entries = new Map<string, TrackerEntry>();
  readonly #clock: Clock;
  readonly #ttlMs: number;
  readonly #maxEntries: number;

  constructor(clock: Clock, ttlMs = TRACKER_ENTRY_TTL_MS, maxEntries = TRACKER_MAX_ENTRIES) {
    this.#clock = clock;
    this.#ttlMs = ttlMs;
    this.#maxEntries = maxEntries;
  }

  begin(requestId: string): void {
    const entry = this.#touch(requestId);
    if (entry.inFlight === 0) {
      // A new request with an idle id: a late mark left by an earlier request must not count for this one.
      entry.markedAt = undefined;
      entry.shared = false;
    } else {
      entry.shared = true;
    }
    entry.inFlight += 1;
  }

  mark(requestId: string): void {
    const entry = this.#touch(requestId);
    entry.markedAt = entry.touchedAt;
  }

  wasRecorded(requestId: string): boolean {
    const entry = this.#entries.get(requestId);
    if (entry?.markedAt === undefined || entry.shared) return false;
    return this.#clock.now() - entry.markedAt < this.#ttlMs;
  }

  release(requestId: string): void {
    const entry = this.#entries.get(requestId);
    if (entry === undefined) return;
    entry.inFlight = Math.max(0, entry.inFlight - 1);
    if (entry.inFlight === 0) this.#entries.delete(requestId);
  }

  /** The entry of `requestId`, created if needed and moved to the young end of the map. */
  #touch(requestId: string): TrackerEntry {
    const now = this.#clock.now();
    const entry = this.#entries.get(requestId) ?? {
      inFlight: 0,
      shared: false,
      markedAt: undefined,
      touchedAt: now,
    };
    entry.touchedAt = now;
    this.#entries.delete(requestId);
    this.#entries.set(requestId, entry);
    this.#evict(now);
    return entry;
  }

  #evict(now: number): void {
    for (const [requestId, entry] of this.#entries) {
      if (this.#entries.size <= this.#maxEntries && now - entry.touchedAt < this.#ttlMs) return;
      this.#entries.delete(requestId);
    }
  }
}

/** The `container.audit` wrapper: marks request ids, then delegates. Lifecycle calls are forwarded. */
export function createTrackingAuditLogger(
  inner: AuditLogger & Lifecycle,
  tracker: InMemoryRequestAuditTracker,
): AuditLogger & Lifecycle {
  return {
    record(event: AuditEvent) {
      if (event.requestId !== undefined && event.requestId !== null) tracker.mark(event.requestId);
      inner.record(event);
    },
    flush: () => inner.flush(),
    start: () => inner.start?.(),
    close: () => inner.close?.() ?? Promise.resolve(),
  };
}
