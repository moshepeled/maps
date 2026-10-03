/**
 * Incremental topology checks for the drawing tool (UX C-06.5), built on the shared robust predicates
 * (`packages/shared/src/geo/segments.ts`) so the client never disagrees with the server's validator (SPEC section 9.2).
 *
 * The placed chain is kept simple by construction (a point that would make it cross is refused), so each pointer move
 * only has to check the one or two edges that touch the moving point: O(n) instead of the validator's full sweep.
 */
import type { IntPoint, Position } from '@snapland/shared';
import { orient, onSegment, segmentRelation, toIntPoint, toPosition } from '@snapland/shared';

export type EdgeIssueKind = 'crossing' | 'fold';

export interface EdgeIssue {
  kind: EdgeIssueKind;
  /** Where the edges meet (the crossing, or the end of a fold-back). */
  location: Position;
  /** The edge being tested. */
  edge: [Position, Position];
  /** The existing edge it crosses or folds over. */
  other: [Position, Position];
}

interface IntEdge {
  a: IntPoint;
  b: IntPoint;
}

function edgeAt(vertices: readonly IntPoint[], index: number, closed: boolean): IntEdge | null {
  const a = vertices[index];
  const nextIndex = index + 1 === vertices.length && closed ? 0 : index + 1;
  const b = vertices[nextIndex];
  return a === undefined || b === undefined ? null : { a, b };
}

function edgeCount(vertexCount: number, closed: boolean): number {
  if (vertexCount < 2) return 0;
  return closed ? vertexCount : vertexCount - 1;
}

function toEdgePositions(edge: IntEdge): [Position, Position] {
  return [toPosition(edge.a), toPosition(edge.b)];
}

/**
 * Adjacent edges (p->v, v->r) fold back when r is collinear with p->v and lies on p's side of v: a zero-width spike
 * ("doubling back"). Returns the end of the overlap, or null.
 */
function foldPoint(p: IntPoint, v: IntPoint, r: IntPoint): IntPoint | null {
  if (orient(p, v, r) !== 0) return null;
  const sameDirection = (p.x - v.x) * (r.x - v.x) + (p.y - v.y) * (r.y - v.y) > 0;
  if (!sameDirection) return null;
  return onSegment(v, p, r) ? r : p;
}

function areAdjacent(i: number, j: number, count: number, closed: boolean): boolean {
  const low = Math.min(i, j);
  const high = Math.max(i, j);
  return high === low + 1 || (closed && low === 0 && high === count - 1);
}

/** The vertex shared by two adjacent edges i -> i+1 (with wrap-around on closed rings). */
function foldBetween(first: IntEdge, second: IntEdge): IntPoint | null {
  if (first.b.x === second.a.x && first.b.y === second.a.y) return foldPoint(first.a, first.b, second.b);
  return foldPoint(second.a, second.b, first.b);
}

/**
 * Checks edge `index` of a polyline (`closed = false`) or ring (`closed = true`) against every other edge: a
 * non-adjacent edge it touches is a crossing; an adjacent edge it folds back over is a fold. Triangles never fold
 * (a folded triangle is merely zero-area, left to the area rule - the shared validator does the same).
 */
export function edgeIssue(vertices: readonly Position[], index: number, closed: boolean): EdgeIssue | null {
  const ints = vertices.map((vertex) => toIntPoint(vertex));
  const count = edgeCount(ints.length, closed);
  const edge = edgeAt(ints, index, closed);
  if (edge === null || index >= count) return null;
  const foldsAllowed = !closed || count > 3;
  for (let other = 0; other < count; other += 1) {
    if (other === index) continue;
    const candidate = edgeAt(ints, other, closed);
    if (candidate === null) continue;
    if (areAdjacent(index, other, count, closed)) {
      if (!foldsAllowed) continue;
      const fold = foldBetween(index < other ? edge : candidate, index < other ? candidate : edge);
      if (fold !== null) {
        return {
          kind: 'fold',
          location: toPosition(fold),
          edge: toEdgePositions(edge),
          other: toEdgePositions(candidate),
        };
      }
      continue;
    }
    const relation = segmentRelation(edge.a, edge.b, candidate.a, candidate.b);
    if (relation.kind !== 'disjoint') {
      return {
        kind: 'crossing',
        location: toPosition(relation.at),
        edge: toEdgePositions(edge),
        other: toEdgePositions(candidate),
      };
    }
  }
  return null;
}

/** Would appending `candidate` to the open chain `points` make it cross or fold (UX C-06.5 placement rule)? */
export function newPointIssue(points: readonly Position[], candidate: Position): EdgeIssue | null {
  if (points.length === 0) return null;
  const chain = [...points, candidate];
  return edgeIssue(chain, chain.length - 2, false);
}

/** Is the closing edge (last -> first) of the placed points' ring invalid? Needs >= 3 points. */
export function closingEdgeIssue(points: readonly Position[]): EdgeIssue | null {
  if (points.length < 3) return null;
  return edgeIssue(points, points.length - 1, true);
}

/**
 * The ring "placed points + provisional point": only the two edges touching the provisional vertex can be new
 * problems, because the placed chain is simple. Returns the first issue (the edge into the provisional point first).
 */
export function provisionalRingIssue(points: readonly Position[], provisional: Position): EdgeIssue | null {
  if (points.length < 2) return null;
  const ring = [...points, provisional];
  return edgeIssue(ring, ring.length - 2, true) ?? edgeIssue(ring, ring.length - 1, true);
}

const FULL_TURN = 360;

/** The equivalent of `lng` (+/- k-360°) closest to `reference` - undoes Leaflet's continuous longitudes. */
export function unwrapLongitude(reference: number, lng: number): number {
  const delta = ((((lng - reference + 180) % FULL_TURN) + FULL_TURN) % FULL_TURN) - 180;
  return reference + delta;
}

/** `lng` wrapped into [−180, 180). */
export function wrapLongitude(lng: number): number {
  return ((((lng + 180) % FULL_TURN) + FULL_TURN) % FULL_TURN) - 180;
}

/** True when every longitude lies in [−180, 180] (else the shape would cross the antimeridian, SPEC section 9.2). */
export function withinLongitudeRange(points: readonly Position[]): boolean {
  return points.every(([lng]) => lng >= -180 && lng <= 180);
}
