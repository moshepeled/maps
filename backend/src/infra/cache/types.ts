/**
 * Bbox query cache contract (SPEC section 3.3, section 10.2): generation-keyed, epoch-safe, L1 in process + L2 on redis-cache.
 * The areas service uses it for every bbox query, cached or not (the plan decides bypass).
 */
import type { Bbox, TileRange } from '@snapland/shared';

export interface BboxQueryPlan {
  zoom: number;
  /** Cache level L = clamp(zoom − 2, 0, 14); null -> bypass (zoom >= 17 or more than 64 key tiles). */
  level: number | null;
  /** The bbox snapped outward to level-L tiles (= the requested bbox when bypassing). */
  queryBbox: Bbox;
  /** Key tiles (closed coverage of queryBbox at level L), null when bypassing. */
  tiles: TileRange | null;
}

export interface BboxQueryKey {
  plan: BboxQueryPlan;
  limit: number;
  cursor: string | null;
}

export type CacheOutcome = 'hit_l1' | 'hit_l2' | 'miss' | 'bypass';

export interface AreaQueryCache {
  /** Returns the serialised JSON body for the query. `loader()` runs on miss or bypass (plan.level === null). */
  getOrLoad(
    key: BboxQueryKey,
    loader: () => Promise<string>,
  ): Promise<{ body: string; outcome: CacheOutcome }>;
  /**
   * Invalidates every cached query that could include any of these bboxes. Called after commit. Never throws: a failed
   * INCR clears this instance's L1 and schedules an epoch bump (section 10.2 step 5).
   */
  invalidate(bboxes: readonly Bbox[]): Promise<void>;
}
