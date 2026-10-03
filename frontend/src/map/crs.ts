/**
 * Zoom mapping across the cross-CRS switch (SPEC section 8.4): Web Mercator zoom <-> ITM cache level by ground resolution,
 * plus the round-trip rule that restores the user's zoom when they come back without zooming in between. The centre
 * is always carried through WGS84 lat/lng, never through pixels.
 */
import { EQUATOR_METERS_PER_PIXEL_Z0 } from '@snapland/shared';

import { ITM_MAX_LEVEL, ITM_RESOLUTIONS } from './itm';

const DEG = Math.PI / 180;

/** Web Mercator metres per pixel at `lat` and `zoom`. */
export function mercatorMpp(lat: number, zoom: number): number {
  return (EQUATOR_METERS_PER_PIXEL_Z0 * Math.cos(lat * DEG)) / 2 ** zoom;
}

/** 3857 -> ITM: the level whose resolution is nearest in log2 (SPEC section 8.4). */
export function mercatorZoomToItmLevel(
  lat: number,
  zoom: number,
  resolutions: readonly number[] = ITM_RESOLUTIONS,
): number {
  const target = Math.log2(mercatorMpp(lat, zoom));
  let best = 0;
  let bestDistance = Number.POSITIVE_INFINITY;
  resolutions.forEach((resolution, level) => {
    const distance = Math.abs(Math.log2(resolution) - target);
    if (distance < bestDistance) {
      best = level;
      bestDistance = distance;
    }
  });
  return best;
}

/** ITM -> 3857: `round(log2(156543.034, cos(lat) / RES[L]))` (SPEC section 8.4). */
export function itmLevelToMercatorZoom(
  lat: number,
  level: number,
  resolutions: readonly number[] = ITM_RESOLUTIONS,
): number {
  const resolution = resolutions[level];
  if (resolution === undefined) throw new RangeError(`ITM level ${level} does not exist`);
  return Math.round(Math.log2((EQUATOR_METERS_PER_PIXEL_Z0 * Math.cos(lat * DEG)) / resolution));
}

export interface ZoomMapping {
  zoom: number;
  /** The requested zoom exceeded the target's range and was clamped (UX section 7 `layer.zoomClamped`). */
  clamped: boolean;
}

/**
 * Remembers `{ fromZoom, toLevel }` of the last 3857 -> ITM switch, so ITM -> 3857 restores `fromZoom` when the level is
 * unchanged (the mapping is not injective: z15 and z16 both map to L7, and L7 maps back to z16).
 */
export class CrsZoomMemory {
  private memory: { fromZoom: number; toLevel: number } | null = null;

  toItm(lat: number, mercatorZoom: number, maxLevel: number = ITM_MAX_LEVEL): ZoomMapping {
    const level = mercatorZoomToItmLevel(lat, mercatorZoom);
    const clampedLevel = Math.min(level, maxLevel);
    this.memory = { fromZoom: mercatorZoom, toLevel: clampedLevel };
    return { zoom: clampedLevel, clamped: clampedLevel !== level };
  }

  toMercator(lat: number, itmLevel: number, minZoom: number, maxZoom: number): ZoomMapping {
    const remembered = this.memory;
    this.memory = null;
    if (remembered?.toLevel === itmLevel) return { zoom: remembered.fromZoom, clamped: false };
    const zoom = itmLevelToMercatorZoom(lat, itmLevel);
    const clampedZoom = Math.max(minZoom, Math.min(maxZoom, zoom));
    return { zoom: clampedZoom, clamped: clampedZoom !== zoom };
  }
}
