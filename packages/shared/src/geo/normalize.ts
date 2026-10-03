/**
 * Polygon normalisation (SPEC section 9.2 stages 5 and 11): 7-dp quantisation, removal of consecutive duplicate positions
 * (the closing position is kept) and RFC 7946 winding (exterior counter-clockwise, holes clockwise). Winding is decided
 * with the planar shoelace sum in lng/lat, matching how GEOS/PostGIS interpret the stored geometry.
 */
import { consecutivePairs } from './pairs.js';
import { COMMITTED_DECIMALS, quantizeRing } from './precision.js';
import type { PolygonCoordinates, Position, Ring } from './types.js';

export function samePosition(a: readonly number[], b: readonly number[]): boolean {
  return a[0] === b[0] && a[1] === b[1];
}

/** Removes consecutive duplicate positions. A closed ring stays closed (its closing position is kept). */
export function dedupeConsecutive(ring: readonly Position[]): Ring {
  const result: Ring = [];
  for (const position of ring) {
    const last = result.at(-1);
    if (last === undefined || !samePosition(last, position)) result.push([position[0], position[1]]);
  }
  return result;
}

/**
 * Twice the signed planar area (shoelace) of a closed ring in degree², positive when counter-clockwise.
 * Only its sign is used (orientation), never its magnitude (areas are geodesic, section 8.5).
 */
export function signedRingArea2(ring: readonly Position[]): number {
  return consecutivePairs(ring).reduce((sum, [[x1, y1], [x2, y2]]) => sum + x1 * y2 - x2 * y1, 0);
}

/** Returns the ring with the requested orientation (a new array; the input is not mutated). */
export function orientRing(ring: readonly Position[], counterClockwise: boolean): Ring {
  const copy = ring.map((position): Position => [position[0], position[1]]);
  const isCounterClockwise = signedRingArea2(copy) > 0;
  return isCounterClockwise === counterClockwise ? copy : copy.reverse();
}

/** RFC 7946 winding: exterior counter-clockwise, holes clockwise (stage 11, never an error). */
export function applyRfc7946Winding(polygon: readonly Ring[]): PolygonCoordinates {
  return polygon.map((ring, index) => orientRing(ring, index === 0));
}

/** Stage 5 of section 9.2: quantise every ring to 7 dp, then drop consecutive duplicates. */
export function quantizeAndDedupe(polygon: readonly (readonly (readonly number[])[])[]): PolygonCoordinates {
  return polygon.map((ring) => dedupeConsecutive(quantizeRing(ring, COMMITTED_DECIMALS)));
}

/**
 * Full normalisation applied before storage and before comparing geometries (section 5.5 idempotent replay, section 10.3 merge):
 * quantise to 7 dp, dedupe, RFC 7946 winding. Callers validate first (`validatePolygon` returns this form).
 */
export function normalizePolygon(polygon: readonly (readonly (readonly number[])[])[]): PolygonCoordinates {
  return applyRfc7946Winding(quantizeAndDedupe(polygon));
}

/** True when two polygons are equal after normalisation (exact comparison of 7-dp coordinates). */
export function polygonsEqual(
  a: readonly (readonly (readonly number[])[])[],
  b: readonly (readonly (readonly number[])[])[],
): boolean {
  const left = normalizePolygon(a);
  const right = normalizePolygon(b);
  if (left.length !== right.length) return false;
  return left.every((ring, ringIndex) => {
    const other = right[ringIndex];
    return ring.length === other?.length && ring.every((p, i) => samePosition(p, other[i] ?? []));
  });
}
