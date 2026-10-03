/**
 * Slippy-map tile math on EPSG:3857 (SPEC section 8.2): tile of a point, tile bounds, the two bbox->tile-range functions
 * (open overlap for snapping, closed coverage for cache keys and invalidation) and the pixel span of a bbox.
 */
import type { Bbox, TileRange } from './types.js';
import { DEG, clampLatitude } from './webmercator.js';

/** Tile size in CSS pixels. */
const TILE_SIZE_PX = 256;

/** Fractional tile x of a longitude at `n = 2^z` tiles per axis. */
export function tileXFraction(lng: number, n: number): number {
  return ((lng + 180) / 360) * n;
}

/** Fractional tile y (y grows southwards) of a latitude at `n = 2^z` tiles per axis. */
export function tileYFraction(lat: number, n: number): number {
  const phi = clampLatitude(lat) * DEG;
  return ((1 - Math.log(Math.tan(phi) + 1 / Math.cos(phi)) / Math.PI) / 2) * n;
}

export function tileXToLng(x: number, n: number): number {
  return (x / n) * 360 - 180;
}

export function tileYToLat(y: number, n: number): number {
  return Math.atan(Math.sinh(Math.PI * (1 - (2 * y) / n))) / DEG;
}

function clampIndex(value: number, n: number): number {
  return Math.max(0, Math.min(n - 1, value));
}

function clampRange(range: TileRange, n: number): TileRange {
  return {
    minX: clampIndex(range.minX, n),
    maxX: clampIndex(range.maxX, n),
    minY: clampIndex(range.minY, n),
    maxY: clampIndex(range.maxY, n),
  };
}

/** The tile containing a point. */
export function tileForPoint(lng: number, lat: number, zoom: number): { x: number; y: number } {
  const n = 2 ** zoom;
  return {
    x: clampIndex(Math.floor(tileXFraction(lng, n)), n),
    y: clampIndex(Math.floor(tileYFraction(lat, n)), n),
  };
}

/** Bounds of tile (z, x, y) as `[west, south, east, north]`. */
export function tileBounds(zoom: number, x: number, y: number): Bbox {
  const n = 2 ** zoom;
  return [tileXToLng(x, n), tileYToLat(y + 1, n), tileXToLng(x + 1, n), tileYToLat(y, n)];
}

/**
 * Tiles whose interior overlaps the bbox (open, positive-area overlap). Used only to snap a requested bbox outward
 * to the tile grid (`snapBboxToTiles`).
 */
export function tilesOverlapping(bbox: Bbox, zoom: number): TileRange {
  const n = 2 ** zoom;
  const [west, south, east, north] = bbox;
  return clampRange(
    {
      minX: Math.floor(tileXFraction(west, n)),
      maxX: Math.ceil(tileXFraction(east, n)) - 1,
      minY: Math.floor(tileYFraction(north, n)),
      maxY: Math.ceil(tileYFraction(south, n)) - 1,
    },
    n,
  );
}

/**
 * Every tile whose closed extent touches the closed bbox - a coordinate exactly on a tile edge belongs to both
 * neighbours. The cache reader (key tiles) and writer (invalidation) both use this one function, which is what makes
 * generation-keyed caching correct for `ST_Intersects` (closed) results (section 8.2 proof).
 */
export function tilesCoveringClosed(bbox: Bbox, zoom: number): TileRange {
  const n = 2 ** zoom;
  const [west, south, east, north] = bbox;
  return clampRange(
    {
      minX: Math.ceil(tileXFraction(west, n)) - 1,
      maxX: Math.floor(tileXFraction(east, n)),
      minY: Math.ceil(tileYFraction(north, n)) - 1,
      maxY: Math.floor(tileYFraction(south, n)),
    },
    n,
  );
}

/** The bbox snapped outward to the bounds of `tilesOverlapping` (the cache grid, section 10.2). */
export function snapBboxToTiles(bbox: Bbox, zoom: number): Bbox {
  const n = 2 ** zoom;
  const range = tilesOverlapping(bbox, zoom);
  return [
    tileXToLng(range.minX, n),
    tileYToLat(range.maxY + 1, n),
    tileXToLng(range.maxX + 1, n),
    tileYToLat(range.minY, n),
  ];
}

export function tileCount(range: TileRange): number {
  return (range.maxX - range.minX + 1) * (range.maxY - range.minY + 1);
}

/**
 * Web-Mercator pixel span of a bbox at `zoom`: `max(Δtx, Δty), 256` (section 5.5). The server rejects spans above
 * `LIMITS.bboxMaxSpanPx`.
 */
export function bboxSpanPx(bbox: Bbox, zoom: number): number {
  const n = 2 ** zoom;
  const [west, south, east, north] = bbox;
  const width = tileXFraction(east, n) - tileXFraction(west, n);
  const height = tileYFraction(south, n) - tileYFraction(north, n);
  return Math.max(width, height) * TILE_SIZE_PX;
}
