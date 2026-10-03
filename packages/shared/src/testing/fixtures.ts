/**
 * Test-only loader for the reference data in `docs/fixtures/geodesic-area-fixtures.json` (PostGIS spheroid areas and
 * GEOS validity verdicts). Not part of the shipped package (excluded from the build and from coverage).
 */
import { readFileSync } from 'node:fs';

export interface ValidPolygonFixture {
  name: string;
  geojson: { type: 'Polygon'; coordinates: [number, number][][] };
  area_km2_spheroid: number;
  area_km2_sphere: number;
  perimeter_km: number;
  area_km2_webmercator_planar_WRONG: number;
  geographiclib_area_km2: number;
  geographiclib_perimeter_km: number;
}

export interface InvalidPolygonFixture {
  name: string;
  geojson: { type: 'Polygon'; coordinates: [number, number][][] };
  invalid_reason: string;
}

interface FixtureFile {
  polygons: ValidPolygonFixture[];
  invalid_polygons: InvalidPolygonFixture[];
}

const FIXTURE_URL = new URL('../../../../docs/fixtures/geodesic-area-fixtures.json', import.meta.url);

let cache: FixtureFile | undefined;

function load(): FixtureFile {
  cache ??= JSON.parse(readFileSync(FIXTURE_URL, 'utf8')) as FixtureFile;
  return cache;
}

export function validFixtures(): ValidPolygonFixture[] {
  return load().polygons;
}

export function invalidFixtures(): InvalidPolygonFixture[] {
  return load().invalid_polygons;
}

export function validFixture(name: string): ValidPolygonFixture {
  const fixture = validFixtures().find((candidate) => candidate.name === name);
  if (!fixture) throw new Error(`unknown fixture ${name}`);
  return fixture;
}

export function invalidFixture(name: string): InvalidPolygonFixture {
  const fixture = invalidFixtures().find((candidate) => candidate.name === name);
  if (!fixture) throw new Error(`unknown invalid fixture ${name}`);
  return fixture;
}

/** Contents of `docs/design/tokens.css` (the single source of the collaborator palette). */
export function readTokensCss(): string {
  return readFileSync(new URL('../../../../docs/design/tokens.css', import.meta.url), 'utf8');
}

/** Relative difference |a − b| / |b|. */
export function relativeDiff(actual: number, expected: number): number {
  return Math.abs(actual - expected) / Math.abs(expected);
}
