/** Geometry primitives in WGS84 lng/lat, GeoJSON axis order (SPEC section 5.1, section 8.1). */

/** `[lng, lat]` in degrees. */
export type Position = [lng: number, lat: number];

/** A closed linear ring (first position === last position). */
export type Ring = Position[];

/** Polygon rings: exterior first, then holes (RFC 7946). */
export type PolygonCoordinates = Ring[];

/** `[west, south, east, north]` in degrees. */
export type Bbox = [west: number, south: number, east: number, north: number];

/** Inclusive tile index range at one zoom level. */
export interface TileRange {
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
}

/** A GeoJSON-shaped polygon. */
export interface PolygonGeometryLike {
  type: string;
  coordinates: readonly (readonly (readonly number[])[])[];
}
