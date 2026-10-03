import { describe, expect, it } from 'vitest';

import { relativeDiff, validFixture, validFixtures } from '../testing/fixtures.js';
import { geodesicArea, geodesicPerimeter } from './geodesic.js';
import { COMMITTED_DECIMALS, quantizePolygon } from './precision.js';

describe('geodesicArea (WGS84, GeographicLib) against the PostGIS fixtures', () => {
  it.each(validFixtures().map((fixture) => [fixture.name, fixture] as const))('%s', (_name, fixture) => {
    const area = geodesicArea(fixture.geojson.coordinates);
    expect(relativeDiff(area, fixture.area_km2_spheroid)).toBeLessThanOrEqual(1e-6);
    expect(relativeDiff(area, fixture.geographiclib_area_km2)).toBeLessThanOrEqual(1e-9);
    expect(
      relativeDiff(geodesicPerimeter(fixture.geojson.coordinates), fixture.perimeter_km),
    ).toBeLessThanOrEqual(1e-6);
  });

  it('stays within 1e-6 of the spheroid value after 7-dp quantisation', () => {
    for (const fixture of validFixtures()) {
      const quantized = quantizePolygon(fixture.geojson.coordinates, COMMITTED_DECIMALS);
      expect(
        relativeDiff(geodesicArea(quantized), fixture.area_km2_spheroid),
        fixture.name,
      ).toBeLessThanOrEqual(1e-6);
    }
  });

  it('is not the planar Web-Mercator area (the classic mistake is far outside the tolerance)', () => {
    const fixture = validFixture('tel_aviv_1km_square');
    expect(
      relativeDiff(fixture.area_km2_webmercator_planar_WRONG, geodesicArea(fixture.geojson.coordinates)),
    ).toBeGreaterThan(0.3);
  });

  it('subtracts holes and ignores the ring orientation', () => {
    const withHole = validFixture('square_with_hole').geojson.coordinates;
    const exteriorOnly = geodesicArea([withHole[0] ?? []]);
    const reversed = geodesicArea(withHole.map((ring) => [...ring].reverse()));
    expect(geodesicArea(withHole)).toBeLessThan(exteriorOnly);
    expect(reversed).toBeCloseTo(geodesicArea(withHole), 9);
  });
});

describe('geodesicArea of an open ring (live drawing)', () => {
  it('equals the closed polygon with the provisional corner, and is 0 below three points', () => {
    const fixture = validFixture('tel_aviv_1km_square');
    const [a, b, c, provisional] = fixture.geojson.coordinates[0] ?? [];
    if (a === undefined || b === undefined || c === undefined || provisional === undefined) {
      throw new Error('the fixture needs four corners');
    }
    expect(relativeDiff(geodesicArea([[a, b, c, provisional]]), fixture.area_km2_spheroid)).toBeLessThan(
      1e-9,
    );
    expect(geodesicArea([[a, b]])).toBe(0);
  });
});
