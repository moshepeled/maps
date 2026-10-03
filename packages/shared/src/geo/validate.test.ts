import { describe, expect, it } from 'vitest';

import { invalidFixture, validFixture, validFixtures } from '../testing/fixtures.js';
import { signedRingArea2 } from './normalize.js';
import type { Position } from './types.js';
import { validatePolygon } from './validate.js';
import type { GeometryIssue, PolygonValidationResult } from './validate.js';

type Coordinates = number[][][];

function polygon(coordinates: Coordinates, type = 'Polygon') {
  return { type, coordinates };
}

function issuesOf(result: PolygonValidationResult): GeometryIssue[] {
  if (result.ok) throw new Error('expected the polygon to be invalid');
  return result.issues;
}

function codesOf(result: PolygonValidationResult): string[] {
  return issuesOf(result).map((issue) => issue.code);
}

/** Distinct codes in first-seen order (one crossing can produce several issues of the same code). */
function distinctCodes(result: PolygonValidationResult): string[] {
  return [...new Set(codesOf(result))];
}

/** Axis-aligned closed rectangle ring, counter-clockwise. */
function rect(west: number, south: number, east: number, north: number): number[][] {
  return [
    [west, south],
    [east, south],
    [east, north],
    [west, north],
    [west, south],
  ];
}

/** A convex n-gon around (lng, lat) with radius r degrees, closed. */
function circle(lng: number, lat: number, r: number, n: number): number[][] {
  const ring = Array.from({ length: n }, (_, i) => [
    lng + r * Math.cos((2 * Math.PI * i) / n),
    lat + r * Math.sin((2 * Math.PI * i) / n),
  ]);
  return [...ring, ring[0] ?? []];
}

describe('validatePolygon - fixtures (section 9.3)', () => {
  it.each(validFixtures().map((fixture) => [fixture.name, fixture] as const))(
    'valid fixture %s passes',
    (_name, fixture) => {
      const result = validatePolygon(fixture.geojson);
      expect(result.ok).toBe(true);
    },
  );

  it('bowtie_self_intersection -> SELF_INTERSECTION at [34.785, 32.085]', () => {
    const [issue] = issuesOf(validatePolygon(invalidFixture('bowtie_self_intersection').geojson));
    expect(issue?.code).toBe('SELF_INTERSECTION');
    expect(issue?.location?.[0]).toBeCloseTo(34.785, 7);
    expect(issue?.location?.[1]).toBeCloseTo(32.085, 7);
    expect(issue?.ring).toBe(0);
    expect(issue?.edgeIndices).toEqual([0, 2]);
    expect(issue?.path).toBe('geometry.coordinates.0');
  });

  it('unclosed_ring -> RING_NOT_CLOSED', () => {
    expect(codesOf(validatePolygon(invalidFixture('unclosed_ring').geojson))).toEqual(['RING_NOT_CLOSED']);
  });

  it('too_few_points -> TOO_FEW_POSITIONS', () => {
    expect(codesOf(validatePolygon(invalidFixture('too_few_points').geojson))).toEqual(['TOO_FEW_POSITIONS']);
  });

  it('duplicate_points_only -> TOO_FEW_POSITIONS (after de-duplication)', () => {
    expect(codesOf(validatePolygon(invalidFixture('duplicate_points_only').geojson))).toEqual([
      'TOO_FEW_POSITIONS',
    ]);
  });

  it('spike -> SELF_INTERSECTION located at the spike base', () => {
    const issues = issuesOf(validatePolygon(invalidFixture('spike').geojson));
    expect(new Set(issues.map((issue) => issue.code))).toEqual(new Set(['SELF_INTERSECTION']));
    expect(issues[0]?.location).toEqual([34.79, 32.09]);
  });
});

describe('validatePolygon - stages 1-12', () => {
  const square = rect(34.78, 32.08, 34.79, 32.09);

  it('stage 1: Polygon-shaped MultiPolygon, 12 rings, 2,001 positions, no rings', () => {
    expect(codesOf(validatePolygon(polygon([square], 'MultiPolygon')))).toEqual(['INVALID_GEOMETRY_TYPE']);
    expect(codesOf(validatePolygon(polygon(Array.from({ length: 12 }, () => square))))).toEqual([
      'TOO_MANY_RINGS',
    ]);
    expect(codesOf(validatePolygon(polygon([circle(34.8, 32.1, 0.01, 2000)])))).toEqual([
      'TOO_MANY_VERTICES',
    ]);
    expect(codesOf(validatePolygon(polygon([])))).toEqual(['TOO_FEW_POSITIONS']);
  });

  it('stage 2: Infinity and NaN (client-side values) -> NON_FINITE_COORDINATE with a position path', () => {
    const ring = rect(34.78, 32.08, 34.79, 32.09);
    ring[1] = [Number.POSITIVE_INFINITY, 32.08];
    ring[2] = [34.79, Number.NaN];
    const issues = issuesOf(validatePolygon(polygon([ring])));
    expect(issues.map((issue) => [issue.code, issue.path])).toEqual([
      ['NON_FINITE_COORDINATE', 'geometry.coordinates.0.1'],
      ['NON_FINITE_COORDINATE', 'geometry.coordinates.0.2'],
    ]);
    expect(codesOf(validatePolygon(polygon([[[1], [2, 3], [4, 5], [1]]])))).toContain(
      'NON_FINITE_COORDINATE',
    );
  });

  it('stage 3: lat 86 and lng 181 -> COORDINATE_OUT_OF_RANGE', () => {
    expect(codesOf(validatePolygon(polygon([rect(34.78, 32.08, 34.79, 86)])))).toEqual([
      'COORDINATE_OUT_OF_RANGE',
      'COORDINATE_OUT_OF_RANGE',
    ]);
    expect(issuesOf(validatePolygon(polygon([rect(180.5, 0, 181, 1)])))[0]?.location).toEqual([180.5, 0]);
  });

  it('stage 4: every ring must be closed', () => {
    const open = rect(34.78, 32.08, 34.79, 32.09).slice(0, 4);
    expect(issuesOf(validatePolygon(polygon([square, open])))).toMatchObject([
      { code: 'RING_NOT_CLOSED', ring: 1 },
    ]);
  });

  it('stage 5/11: removes consecutive duplicates, quantises to 7 dp and returns RFC 7946 winding', () => {
    const clockwiseWithDuplicates = [
      [34.78, 32.08],
      [34.78, 32.09],
      [34.78, 32.09],
      [34.79000000004, 32.09],
      [34.79, 32.08],
      [34.78, 32.08],
    ];
    const result = validatePolygon(polygon([clockwiseWithDuplicates]));
    if (!result.ok) throw new Error(JSON.stringify(result));
    const exterior = result.polygon.coordinates[0] ?? [];
    expect(exterior).toHaveLength(5);
    expect(signedRingArea2(exterior)).toBeGreaterThan(0);
    expect(
      exterior
        .flat()
        .every(
          (value) => Number.isInteger(Math.round(value * 1e7)) && value === Math.round(value * 1e7) / 1e7,
        ),
    ).toBe(true);
  });

  it('stage 11: holes are returned clockwise', () => {
    const result = validatePolygon(validFixture('square_with_hole').geojson);
    if (!result.ok) throw new Error('expected valid');
    expect(signedRingArea2(result.polygon.coordinates[1] ?? [])).toBeLessThan(0);
  });

  it('stage 7: a ring spanning −179...179 -> ANTIMERIDIAN_CROSSING', () => {
    expect(codesOf(validatePolygon(polygon([rect(-179, 0, 179, 1)])))).toEqual(['ANTIMERIDIAN_CROSSING']);
  });

  it('stage 8: 25° wide -> EXTENT_TOO_LARGE', () => {
    expect(codesOf(validatePolygon(polygon([rect(10, 0, 35, 1)])))).toEqual(['EXTENT_TOO_LARGE']);
  });

  it('stage 9: a T-touch and a shared non-adjacent vertex are self-intersections', () => {
    const tTouch = [
      [0, 0],
      [2, 0],
      [2, 2],
      [1, 0],
      [0, 2],
      [0, 0],
    ];
    expect(codesOf(validatePolygon(polygon([tTouch])))[0]).toBe('SELF_INTERSECTION');
    const figureEight = [
      [0, 0],
      [1, 1],
      [2, 0],
      [2, 2],
      [1, 1],
      [0, 2],
      [0, 0],
    ];
    expect(issuesOf(validatePolygon(polygon([figureEight])))[0]).toMatchObject({
      code: 'SELF_INTERSECTION',
      location: [1, 1],
    });
  });

  it('stage 9: a collinear overlap of non-adjacent edges is a self-intersection', () => {
    const overlapping = [
      [0, 0],
      [3, 0],
      [3, 1],
      [2, 1],
      [2, 0],
      [1, 0],
      [1, -1],
      [0, -1],
      [0, 0],
    ];
    expect(codesOf(validatePolygon(polygon([overlapping])))[0]).toBe('SELF_INTERSECTION');
  });

  it('stage 10: a hole outside the shell, touching the shell, overlapping or nested holes', () => {
    const shell = rect(0, 0, 1, 1);
    expect(distinctCodes(validatePolygon(polygon([shell, rect(1.2, 0.1, 1.3, 0.2)])))).toEqual([
      'HOLE_OUTSIDE_SHELL',
    ]);
    expect(distinctCodes(validatePolygon(polygon([shell, rect(0, 0.2, 0.3, 0.3)])))).toEqual([
      'HOLE_OUTSIDE_SHELL',
    ]);
    expect(distinctCodes(validatePolygon(polygon([shell, rect(0.8, 0.8, 1.2, 0.9)])))).toEqual([
      'HOLE_OUTSIDE_SHELL',
    ]);
    expect(
      distinctCodes(validatePolygon(polygon([shell, rect(0.1, 0.1, 0.4, 0.4), rect(0.3, 0.3, 0.6, 0.6)]))),
    ).toEqual(['HOLES_INTERSECT']);
    expect(
      distinctCodes(validatePolygon(polygon([shell, rect(0.1, 0.1, 0.8, 0.8), rect(0.2, 0.2, 0.3, 0.3)]))),
    ).toEqual(['HOLES_INTERSECT']);
    expect(validatePolygon(polygon([shell, rect(0.1, 0.1, 0.2, 0.2), rect(0.3, 0.3, 0.4, 0.4)])).ok).toBe(
      true,
    );
  });

  it('stage 12: three collinear distinct vertices -> AREA_TOO_SMALL; 15°x15° at the equator -> AREA_TOO_LARGE', () => {
    const collinear = [
      [34.78, 32.08],
      [34.79, 32.08],
      [34.8, 32.08],
      [34.78, 32.08],
    ];
    expect(codesOf(validatePolygon(polygon([collinear])))).toEqual(['AREA_TOO_SMALL']);
    expect(codesOf(validatePolygon(polygon([rect(0, 0, 15, 15)])))).toEqual(['AREA_TOO_LARGE']);
  });

  it('returns the geodesic area of a valid polygon', () => {
    const fixture = validFixture('tel_aviv_1km_square');
    const result = validatePolygon(fixture.geojson);
    if (!result.ok) throw new Error('expected valid');
    expect(Math.abs(result.areaKm2 - fixture.area_km2_spheroid) / fixture.area_km2_spheroid).toBeLessThan(
      1e-6,
    );
  });

  it('validates a 2,000-position polygon in well under 100 ms (perf guard)', () => {
    const big = circle(34.8, 32.1, 0.05, 1999);
    const started = performance.now();
    const result = validatePolygon(polygon([big]));
    const elapsed = performance.now() - started;
    expect(result.ok).toBe(true);
    expect(elapsed).toBeLessThan(100);
  });

  it('caps the number of reported issues', () => {
    const zigzag: Position[] = [];
    for (let i = 0; i < 200; i += 1) zigzag.push([i * 0.001, i % 2 === 0 ? 0 : 0.01]);
    for (let i = 199; i >= 0; i -= 1) zigzag.push([i * 0.001, i % 2 === 0 ? 0.01 : 0]);
    zigzag.push(zigzag[0] ?? [0, 0]);
    expect(issuesOf(validatePolygon(polygon([zigzag]))).length).toBeLessThanOrEqual(50);
  });
});
