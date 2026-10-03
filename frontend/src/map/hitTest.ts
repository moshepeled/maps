/**
 * Map click / hover -> area (UX C-08, section 3.3, UX-AC-108): the smallest area whose polygon contains the point wins, so a
 * nested area stays selectable whatever is selected - the canvas draw order is never used for picking. Uses the
 * shared exact integer point-in-ring predicate (the same grid as the validator), with a bbox prefilter.
 */
import type { Bbox, Position } from '@snapland/shared';
import { locatePointInRing, toIntPoint } from '@snapland/shared';

export interface HitCandidate {
  id: string;
  bbox: Bbox;
  rings: readonly (readonly Position[])[];
  areaKm2: number;
}

function inBbox(point: Position, bbox: Bbox): boolean {
  return point[0] >= bbox[0] && point[0] <= bbox[2] && point[1] >= bbox[1] && point[1] <= bbox[3];
}

/** Inside the exterior (boundary counts) and not strictly inside a hole. */
export function polygonContains(rings: readonly (readonly Position[])[], point: Position): boolean {
  const [exterior, ...holes] = rings;
  if (exterior === undefined || exterior.length < 4) return false;
  const target = toIntPoint(point);
  if (
    locatePointInRing(
      target,
      exterior.map((position) => toIntPoint(position)),
    ) === 'outside'
  )
    return false;
  return holes.every(
    (hole) =>
      locatePointInRing(
        target,
        hole.map((position) => toIntPoint(position)),
      ) !== 'inside',
  );
}

/** The topmost (= smallest) area at `point`, or null. Longitudes are compared as given (callers wrap them). */
export function hitTest<T extends HitCandidate>(candidates: Iterable<T>, point: Position): T | null {
  let best: T | null = null;
  for (const candidate of candidates) {
    if (!inBbox(point, candidate.bbox)) continue;
    if (best !== null && candidate.areaKm2 >= best.areaKm2) continue;
    if (polygonContains(candidate.rings, point)) best = candidate;
  }
  return best;
}
