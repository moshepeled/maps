import { describe, expect, it } from 'vitest';

import { CrsZoomMemory, itmLevelToMercatorZoom, mercatorMpp, mercatorZoomToItmLevel } from './crs';

const TEL_AVIV_LAT = 32.08;

describe('crs - zoom <-> ITM level (SPEC section 8.4)', () => {
  it('maps Web Mercator zooms to ITM levels at Tel Aviv: z12->L4, z13->L5, z14->L6, z15->L7, z16->L7', () => {
    expect([12, 13, 14, 15, 16].map((zoom) => mercatorZoomToItmLevel(TEL_AVIV_LAT, zoom))).toEqual([
      4, 5, 6, 7, 7,
    ]);
  });

  it('maps ITM levels back with the rounding formula (L7 -> z16)', () => {
    expect(itmLevelToMercatorZoom(TEL_AVIV_LAT, 7)).toBe(16);
    expect(itmLevelToMercatorZoom(TEL_AVIV_LAT, 4)).toBe(12);
    expect(() => itmLevelToMercatorZoom(TEL_AVIV_LAT, 99)).toThrow(RangeError);
  });

  it('never forces a zoom-out beyond L12 from z19-z21 (overzoom levels, D-1)', () => {
    expect(mercatorZoomToItmLevel(TEL_AVIV_LAT, 19)).toBeLessThanOrEqual(12);
    expect(mercatorZoomToItmLevel(TEL_AVIV_LAT, 21)).toBe(12);
    expect(mercatorMpp(0, 0)).toBeCloseTo(156543.03392804097, 6);
  });

  it('round trip: Map(z15) -> ITM -> Map restores z15', () => {
    const memory = new CrsZoomMemory();
    const toItm = memory.toItm(TEL_AVIV_LAT, 15);
    expect(toItm).toEqual({ zoom: 7, clamped: false });
    expect(memory.toMercator(TEL_AVIV_LAT, 7, 3, 21)).toEqual({ zoom: 15, clamped: false });
  });

  it('round trip after zooming in ITM uses the formula instead', () => {
    const memory = new CrsZoomMemory();
    memory.toItm(TEL_AVIV_LAT, 15);
    expect(memory.toMercator(TEL_AVIV_LAT, 8, 3, 21).zoom).toBe(itmLevelToMercatorZoom(TEL_AVIV_LAT, 8));
    // The memory is consumed by the first return.
    expect(memory.toMercator(TEL_AVIV_LAT, 7, 3, 21).zoom).toBe(16);
  });

  it('clamps and reports when the target range is exceeded', () => {
    const memory = new CrsZoomMemory();
    expect(memory.toItm(TEL_AVIV_LAT, 21, 10)).toEqual({ zoom: 10, clamped: true });
    // L0 maps back to z7, below a minimum zoom of 8.
    expect(new CrsZoomMemory().toMercator(TEL_AVIV_LAT, 0, 8, 21)).toEqual({ zoom: 8, clamped: true });
  });
});
