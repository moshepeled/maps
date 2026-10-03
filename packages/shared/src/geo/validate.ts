/**
 * Domain validation of polygons (SPEC section 9.2 stages 1-12), shared by the client (live feedback) and the server
 * (authoritative, before SQL; PostGIS `ST_IsValid` is stage 13). The first failing stage stops the pipeline and all
 * issues of that stage are reported. The validator is at least as strict as GEOS: it may reject some GEOS-valid
 * shapes (e.g. a hole touching the shell) but never accepts a GEOS-invalid one.
 */
import { LIMITS } from '../constants.js';
import type { GeometryErrorCode } from '../errors.js';
import { geodesicArea } from './geodesic.js';
import { applyRfc7946Winding, quantizeAndDedupe } from './normalize.js';
import { consecutivePairs } from './pairs.js';
import { COMMITTED_DECIMALS, quantize } from './precision.js';
import type { IntPoint } from './segments.js';
import { locatePointInRing, onSegment, orient, segmentRelation, toIntPoint, toPosition } from './segments.js';
import type { PolygonCoordinates, PolygonGeometryLike, Position } from './types.js';

/** One validation problem, serialised into `errors[]` of the INVALID_GEOMETRY problem (section 3.5). */
export interface GeometryIssue {
  code: GeometryErrorCode;
  message: string;
  /** Dotted path into the request body, e.g. `geometry.coordinates.0.3`. */
  path: string;
  location?: Position;
  ring?: number;
  edgeIndices?: [number, number];
}

export type PolygonValidationResult =
  | {
      ok: true;
      /** Normalised polygon: 7-dp, consecutive duplicates removed, RFC 7946 winding. */
      polygon: { type: 'Polygon'; coordinates: PolygonCoordinates };
      /** Geodesic area in km² (the client preview; the server stores PostGIS' value). */
      areaKm2: number;
    }
  | { ok: false; issues: GeometryIssue[] };

/** Upper bound on issues reported for one stage (keeps problem documents small). */
const MAX_ISSUES = 50;

const BASE_PATH = 'geometry.coordinates';

function fail(issues: GeometryIssue[]): PolygonValidationResult {
  return { ok: false, issues: issues.slice(0, MAX_ISSUES) };
}

function positionPath(ring: number, index: number): string {
  return `${BASE_PATH}.${ring}.${index}`;
}

/** Stage 1: type, ring count and total position count. */
function checkStructure(geometry: PolygonGeometryLike): GeometryIssue[] {
  const issues: GeometryIssue[] = [];
  if (geometry.type !== 'Polygon') {
    issues.push({
      code: 'INVALID_GEOMETRY_TYPE',
      message: `Geometry type must be Polygon, got ${geometry.type}.`,
      path: 'geometry.type',
    });
  }
  const rings = geometry.coordinates.length;
  if (rings > LIMITS.maxRings) {
    issues.push({
      code: 'TOO_MANY_RINGS',
      message: `At most ${LIMITS.maxRings} rings are allowed, got ${rings}.`,
      path: BASE_PATH,
    });
  }
  if (rings === 0) {
    issues.push({ code: 'TOO_FEW_POSITIONS', message: 'A polygon needs an exterior ring.', path: BASE_PATH });
  }
  const total = geometry.coordinates.reduce((sum, ring) => sum + ring.length, 0);
  if (total > LIMITS.maxPositionsTotal) {
    issues.push({
      code: 'TOO_MANY_VERTICES',
      message: `At most ${LIMITS.maxPositionsTotal} positions are allowed, got ${total}.`,
      path: BASE_PATH,
    });
  }
  return issues;
}

/** Stages 2 (finite numbers, client-side only in practice) and 3 (coordinate ranges). */
function checkNumbers(geometry: PolygonGeometryLike): {
  nonFinite: GeometryIssue[];
  outOfRange: GeometryIssue[];
} {
  const nonFinite: GeometryIssue[] = [];
  const outOfRange: GeometryIssue[] = [];
  geometry.coordinates.forEach((ring, ringIndex) => {
    ring.forEach((position, index) => {
      const lng = position[0];
      const lat = position[1];
      if (
        position.length !== 2 ||
        lng === undefined ||
        lat === undefined ||
        !Number.isFinite(lng) ||
        !Number.isFinite(lat)
      ) {
        nonFinite.push({
          code: 'NON_FINITE_COORDINATE',
          message: `Position ${index} of ring ${ringIndex} is not a pair of finite numbers.`,
          path: positionPath(ringIndex, index),
          ring: ringIndex,
        });
        return;
      }
      if (Math.abs(lng) > LIMITS.maxLongitude || Math.abs(lat) > LIMITS.maxLatitude) {
        outOfRange.push({
          code: 'COORDINATE_OUT_OF_RANGE',
          message: `Position ${index} of ring ${ringIndex} is outside lng +/-${LIMITS.maxLongitude} / lat +/-${LIMITS.maxLatitude}.`,
          path: positionPath(ringIndex, index),
          location: [lng, lat],
          ring: ringIndex,
        });
      }
    });
  });
  return { nonFinite, outOfRange };
}

/** Stage 4: every ring closed (first position exactly equals the last). */
function checkClosure(geometry: PolygonGeometryLike): GeometryIssue[] {
  const issues: GeometryIssue[] = [];
  geometry.coordinates.forEach((ring, ringIndex) => {
    const first = ring[0];
    const last = ring.at(-1);
    if (
      ring.length === 0 ||
      first === undefined ||
      last === undefined ||
      first[0] !== last[0] ||
      first[1] !== last[1]
    ) {
      issues.push({
        code: 'RING_NOT_CLOSED',
        message: `Ring ${ringIndex} is not closed (its first and last positions differ).`,
        path: `${BASE_PATH}.${ringIndex}`,
        ring: ringIndex,
      });
    }
  });
  return issues;
}

/** Stage 6: each ring keeps at least 4 positions after quantisation and de-duplication. */
function checkCounts(rings: PolygonCoordinates): GeometryIssue[] {
  const issues: GeometryIssue[] = [];
  rings.forEach((ring, ringIndex) => {
    if (ring.length < LIMITS.minRingPositions) {
      issues.push({
        code: 'TOO_FEW_POSITIONS',
        message: `Ring ${ringIndex} has ${ring.length} distinct positions; at least ${LIMITS.minRingPositions} (closed) are required.`,
        path: `${BASE_PATH}.${ringIndex}`,
        ring: ringIndex,
      });
    }
  });
  return issues;
}

/** Stages 7 (antimeridian) and 8 (extent). */
function checkSpans(rings: PolygonCoordinates): { antimeridian: GeometryIssue[]; extent: GeometryIssue[] } {
  const antimeridian: GeometryIssue[] = [];
  let west = Number.POSITIVE_INFINITY;
  let east = Number.NEGATIVE_INFINITY;
  let south = Number.POSITIVE_INFINITY;
  let north = Number.NEGATIVE_INFINITY;
  rings.forEach((ring, ringIndex) => {
    const lngs = ring.map((position) => position[0]);
    const lats = ring.map((position) => position[1]);
    const ringWest = Math.min(...lngs);
    const ringEast = Math.max(...lngs);
    if (ringEast - ringWest > 180) {
      antimeridian.push({
        code: 'ANTIMERIDIAN_CROSSING',
        message: `Ring ${ringIndex} spans more than 180° of longitude (crossing the antimeridian is not supported).`,
        path: `${BASE_PATH}.${ringIndex}`,
        ring: ringIndex,
      });
    }
    west = Math.min(west, ringWest);
    east = Math.max(east, ringEast);
    south = Math.min(south, ...lats);
    north = Math.max(north, ...lats);
  });
  const extent: GeometryIssue[] = [];
  if (east - west > LIMITS.maxExtentDeg || north - south > LIMITS.maxExtentDeg) {
    extent.push({
      code: 'EXTENT_TOO_LARGE',
      message: `The polygon's bounding box must be at most ${LIMITS.maxExtentDeg}° wide and tall.`,
      path: BASE_PATH,
    });
  }
  return { antimeridian, extent };
}

interface Edge {
  ring: number;
  index: number;
  a: IntPoint;
  b: IntPoint;
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
}

function buildEdges(rings: readonly IntPoint[][]): Edge[] {
  const edges: Edge[] = [];
  rings.forEach((ring, ringIndex) => {
    for (const [a, b, index] of consecutivePairs(ring)) {
      edges.push({
        ring: ringIndex,
        index,
        a,
        b,
        minX: Math.min(a.x, b.x),
        maxX: Math.max(a.x, b.x),
        minY: Math.min(a.y, b.y),
        maxY: Math.max(a.y, b.y),
      });
    }
  });
  return edges;
}

/** Sweep over edges sorted by minX: visits every pair whose bounding boxes overlap (closed), each pair once. */
function forEachCandidatePair(edges: readonly Edge[], visit: (first: Edge, second: Edge) => void): void {
  const sorted = [...edges].sort((left, right) => left.minX - right.minX);
  sorted.forEach((first, i) => {
    for (let j = i + 1; j < sorted.length; j += 1) {
      const second = sorted[j];
      if (second === undefined || second.minX > first.maxX) break;
      if (second.maxY < first.minY || second.minY > first.maxY) continue;
      visit(first, second);
    }
  });
}

/** Ring edges i < j share a vertex when consecutive, or when they are the first and last edge of the ring. */
function areAdjacent(first: Edge, second: Edge, edgeCount: number): boolean {
  const [low, high] = first.index < second.index ? [first.index, second.index] : [second.index, first.index];
  return high === low + 1 || (low === 0 && high === edgeCount - 1);
}

/**
 * Adjacent edges (p->v, v->r) are legal unless they fold back over each other (a zero-width spike): collinear with
 * r on the p side of v.
 */
function adjacentEdgesFold(first: Edge, second: Edge): IntPoint | null {
  const [earlier, later] =
    first.b.x === second.a.x && first.b.y === second.a.y ? [first, second] : [second, first];
  const p = earlier.a;
  const v = earlier.b;
  const r = later.b;
  if (orient(p, v, r) !== 0) return null;
  const sameDirection = (p.x - v.x) * (r.x - v.x) + (p.y - v.y) * (r.y - v.y) > 0;
  if (!sameDirection) return null;
  // The overlap ends at whichever far endpoint is closer to v.
  return onSegment(v, p, r) ? r : p;
}

/**
 * A stage 9/10 issue located at the contact point `at` and reported on `ring`. `edges` (two edges of that ring) adds
 * their indices in ascending order; an issue between two different rings has none.
 */
function issue(
  code: GeometryErrorCode,
  message: string,
  ring: number,
  at: IntPoint,
  edges?: [Edge, Edge],
): GeometryIssue {
  const [lng, lat] = toPosition(at);
  const result: GeometryIssue = {
    code,
    message,
    path: `${BASE_PATH}.${ring}`,
    location: [quantize(lng, COMMITTED_DECIMALS), quantize(lat, COMMITTED_DECIMALS)],
    ring,
  };
  if (edges !== undefined) {
    const [first, second] = edges;
    result.edgeIndices = [Math.min(first.index, second.index), Math.max(first.index, second.index)];
  }
  return result;
}

interface TopologyIssues {
  selfIntersections: GeometryIssue[];
  holeShell: GeometryIssue[];
  holeHole: GeometryIssue[];
}

/** One sweep over all edges classifies every touching pair into stage 9 or stage 10 issues. */
function findEdgeIssues(rings: readonly IntPoint[][]): TopologyIssues {
  const found: TopologyIssues = { selfIntersections: [], holeShell: [], holeHole: [] };
  const edgeCounts = rings.map((ring) => ring.length - 1);
  forEachCandidatePair(buildEdges(rings), (first, second) => {
    if (first.ring === second.ring) {
      const edgeCount = edgeCounts[first.ring] ?? 0;
      if (areAdjacent(first, second, edgeCount)) {
        // Only a fold-back can make adjacent edges invalid. A folded triangle is merely degenerate (zero area): it is
        // left to stage 12 (AREA_TOO_SMALL, the section 9.3 "three collinear vertices" case).
        if (edgeCount <= 3) return;
        const fold = adjacentEdgesFold(first, second);
        if (fold !== null) {
          const message = `Ring ${first.ring} folds back on itself (spike).`;
          found.selfIntersections.push(
            issue('SELF_INTERSECTION', message, first.ring, fold, [first, second]),
          );
        }
        return;
      }
      const relation = segmentRelation(first.a, first.b, second.a, second.b);
      if (relation.kind !== 'disjoint') {
        const message = `Ring ${first.ring} self-intersects.`;
        found.selfIntersections.push(
          issue('SELF_INTERSECTION', message, first.ring, relation.at, [first, second]),
        );
      }
      return;
    }
    const relation = segmentRelation(first.a, first.b, second.a, second.b);
    if (relation.kind === 'disjoint') return;
    if (first.ring === 0 || second.ring === 0) {
      const holeRing = first.ring === 0 ? second.ring : first.ring;
      const message = `Hole ${holeRing} touches or crosses the exterior ring.`;
      found.holeShell.push(issue('HOLE_OUTSIDE_SHELL', message, holeRing, relation.at));
    } else {
      const laterRing = Math.max(first.ring, second.ring);
      const message = `Holes ${Math.min(first.ring, second.ring)} and ${laterRing} touch or cross.`;
      found.holeHole.push(issue('HOLES_INTERSECT', message, laterRing, relation.at));
    }
  });
  const byRingAndEdges = (left: GeometryIssue, right: GeometryIssue): number =>
    (left.ring ?? 0) - (right.ring ?? 0) ||
    (left.edgeIndices?.[0] ?? 0) - (right.edgeIndices?.[0] ?? 0) ||
    (left.edgeIndices?.[1] ?? 0) - (right.edgeIndices?.[1] ?? 0);
  found.selfIntersections.sort(byRingAndEdges);
  found.holeShell.sort(byRingAndEdges);
  found.holeHole.sort(byRingAndEdges);
  return found;
}

/** Stage 10 containment (edges already known not to touch): each hole inside the shell, no hole inside another. */
function checkHoleContainment(rings: readonly IntPoint[][]): {
  outside: GeometryIssue[];
  nested: GeometryIssue[];
} {
  const outside: GeometryIssue[] = [];
  const nested: GeometryIssue[] = [];
  const shell = rings[0] ?? [];
  for (let holeIndex = 1; holeIndex < rings.length; holeIndex += 1) {
    const hole = rings[holeIndex] ?? [];
    const probe = hole[0];
    if (probe !== undefined && locatePointInRing(probe, shell) !== 'inside') {
      outside.push({
        code: 'HOLE_OUTSIDE_SHELL',
        message: `Hole ${holeIndex} is not inside the exterior ring.`,
        path: `${BASE_PATH}.${holeIndex}`,
        location: toPosition(probe),
        ring: holeIndex,
      });
    }
    for (let otherIndex = holeIndex + 1; otherIndex < rings.length; otherIndex += 1) {
      const other = rings[otherIndex] ?? [];
      const otherProbe = other[0];
      const holeInOther = probe !== undefined && locatePointInRing(probe, other) === 'inside';
      const otherInHole = otherProbe !== undefined && locatePointInRing(otherProbe, hole) === 'inside';
      if (holeInOther || otherInHole) {
        nested.push({
          code: 'HOLES_INTERSECT',
          message: `Holes ${holeIndex} and ${otherIndex} are nested.`,
          path: `${BASE_PATH}.${otherIndex}`,
          ring: otherIndex,
        });
      }
    }
  }
  return { outside, nested };
}

/**
 * True when every vertex of the ring is collinear (zero planar area). After stage 9 only a triangle can be in this
 * state. Its geodesic area can still exceed 1 m² (a geodesic between two points on a parallel bulges poleward), yet
 * GEOS rejects it, so it must fail here to keep the validator at least as strict as GEOS.
 */
function isCollinearRing(ring: readonly IntPoint[]): boolean {
  const [origin, second] = ring;
  if (origin === undefined || second === undefined) return true;
  return ring.every((point) => orient(origin, second, point) === 0);
}

/** Stage 12: no degenerate (collinear) ring, and a geodesic area within [minAreaKm2, maxAreaKm2]. */
function checkArea(intRings: readonly IntPoint[][], areaKm2: number): GeometryIssue[] {
  const degenerate = intRings.findIndex((ring) => isCollinearRing(ring));
  if (degenerate >= 0) {
    return [
      {
        code: 'AREA_TOO_SMALL',
        message: `Ring ${degenerate} has zero area (all of its vertices are collinear).`,
        path: `${BASE_PATH}.${degenerate}`,
        ring: degenerate,
      },
    ];
  }
  if (areaKm2 < LIMITS.minAreaKm2) {
    return [
      {
        code: 'AREA_TOO_SMALL',
        message: `The area must be at least ${LIMITS.minAreaKm2} km² (1 m²).`,
        path: BASE_PATH,
      },
    ];
  }
  if (areaKm2 > LIMITS.maxAreaKm2) {
    return [
      {
        code: 'AREA_TOO_LARGE',
        message: `The area must be at most ${LIMITS.maxAreaKm2} km².`,
        path: BASE_PATH,
      },
    ];
  }
  return [];
}

/**
 * Validates and normalises a polygon (stages 1-12 of section 9.2). On success the polygon is returned quantised to 7 dp,
 * de-duplicated and wound per RFC 7946, with its geodesic area.
 */
export function validatePolygon(geometry: PolygonGeometryLike): PolygonValidationResult {
  const structure = checkStructure(geometry); // stage 1
  if (structure.length > 0) return fail(structure);

  const { nonFinite, outOfRange } = checkNumbers(geometry); // stages 2 and 3
  if (nonFinite.length > 0) return fail(nonFinite);
  if (outOfRange.length > 0) return fail(outOfRange);

  const closure = checkClosure(geometry); // stage 4
  if (closure.length > 0) return fail(closure);

  const deduped = quantizeAndDedupe(geometry.coordinates); // stage 5

  const counts = checkCounts(deduped); // stage 6
  if (counts.length > 0) return fail(counts);

  const { antimeridian, extent } = checkSpans(deduped); // stages 7 and 8
  if (antimeridian.length > 0) return fail(antimeridian);
  if (extent.length > 0) return fail(extent);

  const intRings = deduped.map((ring) => ring.map((position) => toIntPoint(position)));
  const topology = findEdgeIssues(intRings); // stages 9 and 10 (edges)
  if (topology.selfIntersections.length > 0) return fail(topology.selfIntersections);
  if (topology.holeShell.length > 0 || topology.holeHole.length > 0) {
    return fail([...topology.holeShell, ...topology.holeHole]);
  }
  const containment = checkHoleContainment(intRings); // stage 10 (containment)
  if (containment.outside.length > 0 || containment.nested.length > 0) {
    return fail([...containment.outside, ...containment.nested]);
  }

  const wound = applyRfc7946Winding(deduped); // stage 11
  const areaKm2 = geodesicArea(wound);
  const area = checkArea(intRings, areaKm2); // stage 12
  if (area.length > 0) return fail(area);

  return { ok: true, polygon: { type: 'Polygon', coordinates: wound }, areaKm2 };
}
