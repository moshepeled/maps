/**
 * Coordinate quantisation (SPEC section 8.7). Rounding is half away from zero, so the western and southern hemispheres are
 * treated exactly like the eastern and northern ones (`Math.round` alone rounds halves toward +∞: -2.5 -> -2).
 */
import type { PolygonCoordinates, Position, Ring } from './types.js';

/** Decimals of committed geometry (~ 1.1 cm). */
export const COMMITTED_DECIMALS = 7;
/** Decimals of draft geometry sent over WebSocket (~ 11 cm). */
export const DRAFT_DECIMALS = 6;

/**
 * Rounds `value` to `decimals` places, half away from zero, and turns `-0` into `0`. Idempotent:
 * `quantize(quantize(v, d), d) === quantize(v, d)`.
 */
export function quantize(value: number, decimals: number): number {
  const factor = 10 ** decimals;
  const rounded = (Math.sign(value) * Math.round(Math.abs(value) * factor)) / factor;
  return rounded === 0 ? 0 : rounded;
}

export function quantizePosition(position: readonly number[], decimals: number): Position {
  return [quantize(position[0] ?? Number.NaN, decimals), quantize(position[1] ?? Number.NaN, decimals)];
}

export function quantizeRing(ring: readonly (readonly number[])[], decimals: number): Ring {
  return ring.map((position) => quantizePosition(position, decimals));
}

export function quantizePolygon(
  polygon: readonly (readonly (readonly number[])[])[],
  decimals: number,
): PolygonCoordinates {
  return polygon.map((ring) => quantizeRing(ring, decimals));
}
