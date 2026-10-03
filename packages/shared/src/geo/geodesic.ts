/**
 * Geodesic area and perimeter on the WGS84 ellipsoid (SPEC section 8.5) with GeographicLib (Karney), the same algorithm as
 * PostGIS `ST_Area(geography)` - they agree to ~1e-12 relative. Planar Web-Mercator area is never used for
 * measurement (it overestimates by ~1.4x in Israel).
 */
import geographiclib from 'geographiclib-geodesic';

const WGS84 = geographiclib.Geodesic.WGS84;

interface RingMetrics {
  /** Unsigned area in m². */
  areaM2: number;
  /** Length of the closed loop in m. */
  perimeterM: number;
}

/** A closed ring repeats its first position at the end; GeographicLib wants each vertex once. */
function distinctVertices(ring: readonly (readonly number[])[]): readonly (readonly number[])[] {
  const first = ring[0];
  const last = ring.at(-1);
  const closed =
    ring.length > 1 &&
    first !== undefined &&
    last !== undefined &&
    first[0] === last[0] &&
    first[1] === last[1];
  return closed ? ring.slice(0, -1) : ring;
}

function ringMetrics(ring: readonly (readonly number[])[]): RingMetrics {
  const vertices = distinctVertices(ring);
  if (vertices.length < 3) return { areaM2: 0, perimeterM: 0 };
  const polygon = WGS84.Polygon(false);
  for (const vertex of vertices) polygon.AddPoint(vertex[1] ?? Number.NaN, vertex[0] ?? Number.NaN);
  const result = polygon.Compute(false, true);
  return { areaM2: Math.abs(result.area ?? 0), perimeterM: result.perimeter };
}

/**
 * Area in km² of a polygon (exterior minus holes), rings in `[lng, lat]`. A ring may be open (the live drawing: its
 * vertices plus the cursor point); a ring of fewer than 3 distinct vertices has no area.
 */
export function geodesicArea(rings: readonly (readonly (readonly number[])[])[]): number {
  let areaM2 = 0;
  rings.forEach((ring, index) => {
    const { areaM2: ringArea } = ringMetrics(ring);
    areaM2 += index === 0 ? ringArea : -ringArea;
  });
  return Math.max(0, areaM2) / 1e6;
}

/** Perimeter in km: the sum of every ring's length (PostGIS `ST_Perimeter(geography)` semantics). */
export function geodesicPerimeter(rings: readonly (readonly (readonly number[])[])[]): number {
  return rings.reduce((sum, ring) => sum + ringMetrics(ring).perimeterM, 0) / 1e3;
}
