/** Protocol constants of SPEC section 7.8 that are not configurable (inbound throttling, invalid accounting, framing). */
import { REALTIME } from '@snapland/shared';

export const PROTOCOL_LIMITS = {
  /** Inbound token bucket per connection. */
  inboundBurst: 40,
  inboundRefillPerSecond: 20,
  /** More than this many throttled messages within `floodWindowMs` -> close 4429. */
  floodDropLimit: 200,
  floodWindowMs: 10_000,
  /** More than this many invalid messages within `invalidWindowMs` -> close 4400. */
  invalidLimit: 20,
  invalidWindowMs: 60_000,
  /** Draft ids a connection remembers having owned (their DRAFT_NOT_FOUND is not counted as invalid, section 7.6). */
  ownedDraftMemory: 8,
  /** Ephemeral lane bound (keys). */
  maxEphemeralKeys: 500,
  /** Frame size cap of one outbound frame (a single larger message is still sent alone). */
  maxFrameBytes: 64 * 1024,
  /** Inbound messages waiting for the per-connection serial handler before new ones are throttled. */
  maxPendingInbound: 256,
  /** Presence broadcasts per connection are coalesced to at most one per this interval (section 7.7). */
  presencePublishIntervalMs: 1000,
  /** Entries in presence.snapshot / GET /presence and lock.snapshot (section 7.5, section 7.7). */
  presenceSnapshotMax: REALTIME.presenceSnapshotMax,
  lockSnapshotMax: REALTIME.lockSnapshotMax,
  /** Session ids per SessionReader.getActiveMany call (section 7.2 step 5). */
  revalidationBatchSize: 500,
  /** +/-10 % jitter of the re-validation interval. */
  revalidationJitter: 0.1,
  /** Presence entries swept per Lua call. */
  presenceSweepBatch: 500,
  /** Local connections refreshed per Lua call. */
  presenceRefreshBatch: 500,
} as const;
