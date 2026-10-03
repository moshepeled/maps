/**
 * Robust planar predicates for polygon validation (SPEC section 9.2 algorithm notes). Coordinates are scaled to integers of
 * 1e-7° (exact after the 7-dp quantisation of stage 5); orientation uses a floating-point filter with an exact BigInt
 * fallback whenever the float result is within its error bound, so near-collinear decisions are never wrong.
 */
import { consecutivePairs } from './pairs.js';
import type { Position } from './types.js';

/** A point in integer units of 1e-7 degree. */
export interface IntPoint {
  x: number;
  y: number;
}

const SCALE = 1e7;
/** Relative error bound of `l - r` where l and r are products of exact doubles (conservative: 3-2^-53 plus slack). */
const ORIENT_ERROR_BOUND = 4 * Number.EPSILON;

export function toIntPoint(position: readonly number[]): IntPoint {
  return {
    x: Math.round((position[0] ?? Number.NaN) * SCALE),
    y: Math.round((position[1] ?? Number.NaN) * SCALE),
  };
}

export function toPosition(point: IntPoint): Position {
  return [point.x / SCALE, point.y / SCALE];
}

/**
 * Orientation of the triple (a, b, c): 1 = counter-clockwise (c left of a->b), -1 = clockwise, 0 = collinear. Exact.
 */
export function orient(a: IntPoint, b: IntPoint, c: IntPoint): -1 | 0 | 1 {
  const left = (b.x - a.x) * (c.y - a.y);
  const right = (b.y - a.y) * (c.x - a.x);
  const det = left - right;
  const bound = ORIENT_ERROR_BOUND * (Math.abs(left) + Math.abs(right));
  if (det > bound) return 1;
  if (-det > bound) return -1;
  // Too close to call in floating point: decide exactly (differences of integers < 2^32 are exact doubles).
  const exact = BigInt(b.x - a.x) * BigInt(c.y - a.y) - BigInt(b.y - a.y) * BigInt(c.x - a.x);
  return exact > 0n ? 1 : exact < 0n ? -1 : 0;
}

/** For c collinear with a-b: is c within the closed bounding box of a-b (i.e. on the closed segment)? */
export function onSegment(a: IntPoint, b: IntPoint, c: IntPoint): boolean {
  return (
    Math.min(a.x, b.x) <= c.x &&
    c.x <= Math.max(a.x, b.x) &&
    Math.min(a.y, b.y) <= c.y &&
    c.y <= Math.max(a.y, b.y)
  );
}

export type SegmentRelation =
  | { kind: 'disjoint' }
  /** The closed segments share exactly one point (proper crossing or touch). */
  | { kind: 'point'; at: IntPoint }
  /** Collinear segments overlapping over more than one point. */
  | { kind: 'overlap'; at: IntPoint };

function crossingPoint(p1: IntPoint, p2: IntPoint, q1: IntPoint, q2: IntPoint): IntPoint {
  const rx = p2.x - p1.x;
  const ry = p2.y - p1.y;
  const sx = q2.x - q1.x;
  const sy = q2.y - q1.y;
  const denominator = rx * sy - ry * sx;
  const t = ((q1.x - p1.x) * sy - (q1.y - p1.y) * sx) / denominator;
  return { x: Math.round(p1.x + t * rx), y: Math.round(p1.y + t * ry) };
}

function samePoint(a: IntPoint, b: IntPoint): boolean {
  return a.x === b.x && a.y === b.y;
}

/** Relation of the closed segments p1-p2 and q1-q2 (touching counts as intersecting). */
export function segmentRelation(p1: IntPoint, p2: IntPoint, q1: IntPoint, q2: IntPoint): SegmentRelation {
  const o1 = orient(p1, p2, q1);
  const o2 = orient(p1, p2, q2);
  const o3 = orient(q1, q2, p1);
  const o4 = orient(q1, q2, p2);

  if (o1 === 0 && o2 === 0) {
    // Collinear: overlapping, touching at one end, or disjoint.
    const onP = [q1, q2].filter((q) => onSegment(p1, p2, q));
    const onQ = [p1, p2].filter((p) => onSegment(q1, q2, p));
    const shared = [...onP, ...onQ];
    const first = shared[0];
    if (first === undefined) return { kind: 'disjoint' };
    const distinct = shared.filter(
      (point, index) => shared.findIndex((other) => samePoint(other, point)) === index,
    );
    return distinct.length > 1 ? { kind: 'overlap', at: first } : { kind: 'point', at: first };
  }
  if (o1 !== o2 && o3 !== o4) {
    if (o1 === 0) return { kind: 'point', at: q1 };
    if (o2 === 0) return { kind: 'point', at: q2 };
    if (o3 === 0) return { kind: 'point', at: p1 };
    if (o4 === 0) return { kind: 'point', at: p2 };
    return { kind: 'point', at: crossingPoint(p1, p2, q1, q2) };
  }
  return { kind: 'disjoint' };
}

export type PointLocation = 'inside' | 'outside' | 'boundary';

/**
 * Location of a point relative to a closed ring (winding number with exact orientation; the boundary is detected
 * explicitly). The ring's orientation does not matter.
 */
export function locatePointInRing(point: IntPoint, ring: readonly IntPoint[]): PointLocation {
  let winding = 0;
  for (const [a, b] of consecutivePairs(ring)) {
    const side = orient(a, b, point);
    if (side === 0 && onSegment(a, b, point)) return 'boundary';
    if (a.y <= point.y) {
      if (b.y > point.y && side > 0) winding += 1;
    } else if (b.y <= point.y && side < 0) {
      winding -= 1;
    }
  }
  return winding === 0 ? 'outside' : 'inside';
}
