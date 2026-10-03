/**
 * Israeli Transverse Mercator (EPSG:2039) math (SPEC section 8.1, section 8.3): the proj4 definition shared by the coordinate
 * readout (every build) and the GovMap 2022 ITM base layer, the cache's resolution ladder, and its tile URLs.
 * Pure - the Leaflet CRS and tile layer live in `itmLayer.ts`.
 */
import proj4 from 'proj4';

export const EPSG_2039 = 'EPSG:2039';

/** The current 7-parameter epsg.io definition (SPEC section 8.1); PostGIS' 3-parameter shift differs by ~ 9.7 m. */
export const ITM_PROJ4 =
  '+proj=tmerc +lat_0=31.7343936111111 +lon_0=35.2045169444444 +k=1.0000067 +x_0=219529.584 +y_0=626907.39 ' +
  '+ellps=GRS80 +towgs84=23.772,17.49,17.859,-0.3132,-1.85274,1.67299,-5.4262 +units=m +no_defs';

proj4.defs(EPSG_2039, ITM_PROJ4);

/** Tile-matrix origin (top-left) of the GovMap LPD0BBK2022 cache, in ITM metres. */
export const ITM_ORIGIN: readonly [number, number] = [-5403700, 7116700];

/**
 * Metres per pixel of levels L0-L10 (native) plus the L11/L12 overzoom levels (user decision D-1, SPEC section 8.3).
 */
export const ITM_RESOLUTIONS: readonly number[] = [
  793.751587503175, 264.583862501058, 132.291931250529, 66.1459656252646, 26.4583862501058, 13.2291931250529,
  6.61459656252646, 2.64583862501058, 1.32291931250529, 0.661459656252646, 0.330729828126323,
  0.165364914063161, 0.0826824570315806,
];

export const ITM_MAX_NATIVE_LEVEL = 10;
export const ITM_MAX_LEVEL = ITM_RESOLUTIONS.length - 1;
/** Coverage of the cache: [minE, minN, maxE, maxN] in ITM metres. */
export const ITM_BOUNDS: readonly [number, number, number, number] = [100000, 350000, 300000, 800000];

/** The undocumented dataset id lives here, in one place (ADR-0009); T6 probes it live. */
export const GOVMAP_ITM_TILE_BASE = 'https://cdn.govmap.gov.il/LPD0BBK2022';

const TILE_PX = 256;

export interface ItmPoint {
  e: number;
  n: number;
}

/** WGS84 lng/lat -> ITM easting/northing (metres). */
export function toItm(lng: number, lat: number): ItmPoint {
  const [e, n] = proj4('EPSG:4326', EPSG_2039, [lng, lat]);
  return { e, n };
}

/** ITM easting/northing -> WGS84 `[lng, lat]`. */
export function fromItm(e: number, n: number): [number, number] {
  const [lng, lat] = proj4(EPSG_2039, 'EPSG:4326', [e, n]);
  return [lng, lat];
}

function hex8(value: number): string {
  return value.toString(16).padStart(8, '0');
}

function pad2(value: number): string {
  return String(value).padStart(2, '0');
}

/** `.../L{LL}/R{row:08x}/C{col:08x}.jpg` (SPEC section 8.3; `{row}`/`{col}` are not Leaflet template tokens). */
export function itmTileUrl(level: number, col: number, row: number): string {
  return `${GOVMAP_ITM_TILE_BASE}/L${pad2(level)}/R${hex8(row)}/C${hex8(col)}.jpg`;
}

/** The cache tile containing an ITM point at `level` (SPEC section 8.1 formula). */
export function itmTileForPoint(point: ItmPoint, level: number): { col: number; row: number } {
  const resolution = ITM_RESOLUTIONS[level];
  if (resolution === undefined) throw new RangeError(`ITM level ${level} does not exist`);
  const span = TILE_PX * resolution;
  return {
    col: Math.floor((point.e - ITM_ORIGIN[0]) / span),
    row: Math.floor((ITM_ORIGIN[1] - point.n) / span),
  };
}

/** Is a WGS84 point inside the ITM cache coverage? (The *Aerial* coverage notice, UX section 7.) */
export function insideItmCoverage(lng: number, lat: number): boolean {
  const { e, n } = toItm(lng, lat);
  return e >= ITM_BOUNDS[0] && e <= ITM_BOUNDS[2] && n >= ITM_BOUNDS[1] && n <= ITM_BOUNDS[3];
}
