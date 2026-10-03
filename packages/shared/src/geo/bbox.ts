/** Bounding-box helpers in lng/lat degrees (`[west, south, east, north]`). All comparisons are closed. */
import { LIMITS } from '../constants.js';
import type { Bbox } from './types.js';

/** Bbox of a list of positions; null for an empty list. */
export function bboxOfPositions(positions: Iterable<readonly number[]>): Bbox | null {
  let west = Number.POSITIVE_INFINITY;
  let south = Number.POSITIVE_INFINITY;
  let east = Number.NEGATIVE_INFINITY;
  let north = Number.NEGATIVE_INFINITY;
  let any = false;
  for (const position of positions) {
    const lng = position[0] ?? Number.NaN;
    const lat = position[1] ?? Number.NaN;
    west = Math.min(west, lng);
    east = Math.max(east, lng);
    south = Math.min(south, lat);
    north = Math.max(north, lat);
    any = true;
  }
  return any ? [west, south, east, north] : null;
}

/** Closed intersection test (touching boxes intersect, like `ST_Intersects`). */
export function bboxesIntersect(a: Bbox, b: Bbox): boolean {
  return a[0] <= b[2] && b[0] <= a[2] && a[1] <= b[3] && b[1] <= a[3];
}

/** True when `outer` contains `inner` (closed). */
export function bboxContains(outer: Bbox, inner: Bbox): boolean {
  return outer[0] <= inner[0] && outer[1] <= inner[1] && inner[2] <= outer[2] && inner[3] <= outer[3];
}

/**
 * Expands a bbox by `fraction` of its width/height on each side, clamped to the displayable world. Used for WS
 * interest regions (50 %, section 7.8) and padded viewports (25 %, section 8.6).
 */
export function expandBbox(bbox: Bbox, fraction: number): Bbox {
  const dx = (bbox[2] - bbox[0]) * fraction;
  const dy = (bbox[3] - bbox[1]) * fraction;
  return [
    Math.max(-180, bbox[0] - dx),
    Math.max(-LIMITS.maxLatitude, bbox[1] - dy),
    Math.min(180, bbox[2] + dx),
    Math.min(LIMITS.maxLatitude, bbox[3] + dy),
  ];
}
