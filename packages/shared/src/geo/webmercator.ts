/**
 * EPSG:3857 (Web Mercator) projection used for display and tile math only (SPEC section 8.1, section 8.2) - never for measurement.
 */
import { LIMITS } from '../constants.js';
import type { Position } from './types.js';

/** Sphere radius of EPSG:3857 in metres. */
export const EARTH_RADIUS_M = 6_378_137;
/** Ground resolution at the equator for zoom 0 and 256-px tiles, in metres per pixel. */
export const EQUATOR_METERS_PER_PIXEL_Z0 = 156_543.033_928_040_97;

/** Radians per degree. */
export const DEG = Math.PI / 180;

export function clampLatitude(lat: number): number {
  return Math.max(-LIMITS.maxLatitude, Math.min(LIMITS.maxLatitude, lat));
}

/** `[lng, lat]` -> EPSG:3857 metres. Latitude is clamped to the Mercator limit. */
export function projectToMercator(lng: number, lat: number): { x: number; y: number } {
  const phi = clampLatitude(lat) * DEG;
  return { x: EARTH_RADIUS_M * lng * DEG, y: EARTH_RADIUS_M * Math.log(Math.tan(Math.PI / 4 + phi / 2)) };
}

/** EPSG:3857 metres -> `[lng, lat]`. */
export function unprojectFromMercator(x: number, y: number): Position {
  const lng = x / EARTH_RADIUS_M / DEG;
  const lat = (2 * Math.atan(Math.exp(y / EARTH_RADIUS_M)) - Math.PI / 2) / DEG;
  return [lng, lat];
}

/** Metres per screen pixel at latitude `lat` and zoom `zoom` (256-px tiles). */
export function metersPerPixel(lat: number, zoom: number): number {
  return (EQUATOR_METERS_PER_PIXEL_Z0 * Math.cos(clampLatitude(lat) * DEG)) / 2 ** zoom;
}
