/**
 * Level of detail of bbox list queries (SPEC section 5.5 LOD table): simplification tolerance, sub-pixel culling threshold
 * and GeoJSON precision per zoom. Simplified list geometry is display-only; editing loads full precision.
 */

export interface LevelOfDetail {
  /** `ST_Simplify(geom, simplifyDeg, true)` tolerance in degrees; 0 = no simplification. */
  simplifyDeg: number;
  /** Areas whose bbox extent is below this are culled (reported as `culledCount`); 0 = none. */
  minExtentDeg: number;
  /** `ST_AsGeoJSON` decimal digits. */
  digits: number;
  /** True when list geometry may be simplified (the client must not edit it). */
  simplified: boolean;
}

/** Degrees covered by one 256-px tile pixel at `zoom` (longitude). */
function pixelDeg(zoom: number): number {
  return 360 / (256 * 2 ** zoom);
}

/** The LOD for an integer zoom 0-22 (the bbox query schema bounds it). */
export function lodForZoom(zoom: number): LevelOfDetail {
  if (zoom >= 17) return { simplifyDeg: 0, minExtentDeg: 0, digits: 7, simplified: false };
  const simplifyDeg = 0.5 * pixelDeg(zoom);
  if (zoom >= 15) return { simplifyDeg, minExtentDeg: 0, digits: 6, simplified: true };
  const minExtentDeg = 2 * pixelDeg(zoom);
  if (zoom === 14) return { simplifyDeg, minExtentDeg, digits: 6, simplified: true };
  if (zoom >= 10) return { simplifyDeg, minExtentDeg, digits: 5, simplified: true };
  return { simplifyDeg, minExtentDeg, digits: 4, simplified: true };
}
