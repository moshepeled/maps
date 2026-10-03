/** Internal types shared by the realtime components (SPEC section 7). */
import type { Bbox, ClientMessageOf, Position } from '@snapland/shared';

import type { DraftCoalescer } from './draft-coalescer.js';
import type { Cancel } from './timers.js';

/** `ws.disconnect` aggregates (section 10.4 trail 3). */
export interface ConnectionCounts {
  viewportSets: number;
  draftUpdates: number;
  draftTouches: number;
  presenceUpdates: number;
  locks: number;
  pings: number;
}

/** The latest state of a draft as relayed to viewers (6 dp, bbox of vertices + cursor). */
export interface DraftFrame {
  rev: number;
  vertices: Position[];
  cursor: Position | null;
  bbox: Bbox | null;
}

/** The connection's one active draft (section 7.6); the connection's local state is authoritative for update/touch. */
export interface ActiveDraft {
  readonly draftId: string;
  /** The edited area, or null for a new area. */
  readonly areaId: string | null;
  lastRev: number;
  readonly coalescer: DraftCoalescer<DraftFrame>;
  cancelIdle: Cancel | null;
  /** Started while Redis was unreachable: ownership is local only (availability over strictness, section 7.6). */
  readonly localOnly: boolean;
}

export type LockScope = ClientMessageOf<'lock.acquire'>['data']['scope'];

/** A soft lock held by the connection (section 7.9); Map insertion order = acquisition order. */
export interface HeldLock {
  readonly areaId: string;
  readonly bbox: Bbox;
  scope: LockScope;
}
