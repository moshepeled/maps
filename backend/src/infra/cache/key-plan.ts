/**
 * Pure planning of the generation-keyed bbox cache (SPEC section 10.2 steps 2-5, section 8.2): cache level, snapped query bbox, key
 * tiles, invalidation targets and the cache key itself. Reader (key tiles) and writer (invalidation) both use the
 * CLOSED tile coverage, which is what makes every edit of a returned polygon bump a generation in the reader's key.
 */
import { createHash } from 'node:crypto';

import { snapBboxToTiles, tileCount, tilesCoveringClosed } from '@snapland/shared';
import type { Bbox, TileRange } from '@snapland/shared';

import type { BboxQueryKey, BboxQueryPlan } from './types.js';

/** Bbox cache plan constants (section 10.2). */
const CACHE = {
  /** Cache level L = clamp(zoom − levelOffset, 0, maxLevel). */
  levelOffset: 2,
  maxLevel: 14,
  /** zoom >= bypassZoom -> no cache (small, fast queries). */
  bypassZoom: 17,
  /** More key tiles than this -> bypass. */
  maxKeyTiles: 64,
  /** More covering tiles than this at a level -> bump the level's "big" generation instead. */
  maxInvalidateTilesPerLevel: 16,
} as const;

/** Version tag of the key material; bump it when the key format changes. */
const CACHE_KEY_VERSION = 'v1';

/** Cache level for a zoom, or null when the zoom is never cached (>= 17: small, fast queries). */
export function cacheLevelForZoom(zoom: number): number | null {
  if (zoom >= CACHE.bypassZoom) return null;
  return Math.max(0, Math.min(CACHE.maxLevel, zoom - CACHE.levelOffset));
}

/** Plans a bbox query: snapping, key tiles and the bypass decision. */
export function planBboxQuery(bbox: Bbox, zoom: number): BboxQueryPlan {
  const level = cacheLevelForZoom(zoom);
  if (level === null) return { zoom, level: null, queryBbox: bbox, tiles: null };
  const queryBbox = snapBboxToTiles(bbox, level);
  const tiles = tilesCoveringClosed(queryBbox, level);
  if (tileCount(tiles) > CACHE.maxKeyTiles) return { zoom, level: null, queryBbox: bbox, tiles: null };
  return { zoom, level, queryBbox, tiles };
}

/** Per level 0...14: the tiles to bump, or 'big' when more than 16 tiles would be touched (section 10.2 step 5). */
export function tilesToInvalidate(bbox: Bbox): { level: number; tiles: TileRange | 'big' }[] {
  const targets: { level: number; tiles: TileRange | 'big' }[] = [];
  for (let level = 0; level <= CACHE.maxLevel; level += 1) {
    const tiles = tilesCoveringClosed(bbox, level);
    targets.push({ level, tiles: tileCount(tiles) > CACHE.maxInvalidateTilesPerLevel ? 'big' : tiles });
  }
  return targets;
}

/** The key tiles of a plan in row-major order (empty when bypassing). */
export function keyTiles(plan: BboxQueryPlan): { x: number; y: number }[] {
  if (plan.tiles === null) return [];
  const tiles: { x: number; y: number }[] = [];
  for (let y = plan.tiles.minY; y <= plan.tiles.maxY; y += 1) {
    for (let x = plan.tiles.minX; x <= plan.tiles.maxX; x += 1) tiles.push({ x, y });
  }
  return tiles;
}

/** Generations read (in one MGET) right before querying. */
export interface GenerationSnapshot {
  /** Random global epoch (`gen:global`); a new epoch invalidates everything cached before it. */
  epoch: string;
  /** The level's `big` generation. */
  big: number;
  /** Generation per key tile, in `keyTiles(plan)` order (missing generations read as 0). */
  tiles: readonly number[];
}

/** `v1|L|zoom|limit|cursor|queryBbox|epoch|big|x:y=gen,...` - the exact material of section 10.2 step 4. */
export function cacheKeyMaterial(key: BboxQueryKey, generations: GenerationSnapshot): string {
  const tiles = keyTiles(key.plan)
    .map((tile, index) => `${tile.x}:${tile.y}=${generations.tiles[index] ?? 0}`)
    .join(',');
  return [
    CACHE_KEY_VERSION,
    key.plan.level ?? 'bypass',
    key.plan.zoom,
    key.limit,
    key.cursor ?? '',
    key.plan.queryBbox.join(','),
    generations.epoch,
    generations.big,
    tiles,
  ].join('|');
}

/** sha1 hex of the key material (the `<hash>` of `snap:cache:bbox:<hash>`). */
export function cacheKeyHash(key: BboxQueryKey, generations: GenerationSnapshot): string {
  return createHash('sha1').update(cacheKeyMaterial(key, generations)).digest('hex');
}

/** A fresh random 52-bit epoch (safe integer), as a decimal string. */
export function randomEpoch(random: () => number = Math.random): string {
  return String(Math.floor(random() * 2 ** 52));
}
