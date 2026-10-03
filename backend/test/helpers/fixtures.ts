/** Loader of `docs/fixtures/geodesic-area-fixtures.json` (PostGIS reference areas and GEOS verdicts, SPEC section 9.3). */
import { readFileSync } from 'node:fs';

export interface PolygonFixture {
  name: string;
  geojson: { type: 'Polygon'; coordinates: [number, number][][] };
  area_km2_spheroid?: number;
  perimeter_km?: number;
  valid: boolean;
  invalid_reason: string | null;
}

interface FixtureFile {
  polygons: PolygonFixture[];
  invalid_polygons: PolygonFixture[];
}

const FIXTURE_URL = new URL('../../../docs/fixtures/geodesic-area-fixtures.json', import.meta.url);

let cache: FixtureFile | undefined;

export function loadFixtures(): FixtureFile {
  cache ??= JSON.parse(readFileSync(FIXTURE_URL, 'utf8')) as FixtureFile;
  return cache;
}

export function fixture(name: string): PolygonFixture {
  const found = [...loadFixtures().polygons, ...loadFixtures().invalid_polygons].find(
    (candidate) => candidate.name === name,
  );
  if (found === undefined) throw new Error(`unknown fixture ${name}`);
  return found;
}
