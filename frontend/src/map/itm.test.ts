import { describe, expect, it } from 'vitest';

import { fromItm, insideItmCoverage, itmTileForPoint, itmTileUrl, toItm } from './itm';

describe('itm - proj4 vectors (SPEC section 8.1, +/- 0.01 m)', () => {
  it('(34.78, 32.08) -> E 179383.784, N 665268.335', () => {
    const { e, n } = toItm(34.78, 32.08);
    expect(Math.abs(e - 179383.784)).toBeLessThanOrEqual(0.01);
    expect(Math.abs(n - 665268.335)).toBeLessThanOrEqual(0.01);
  });

  it('(35.0, 29.55) -> E 199642.122, N 384711.599', () => {
    const { e, n } = toItm(35.0, 29.55);
    expect(Math.abs(e - 199642.122)).toBeLessThanOrEqual(0.01);
    expect(Math.abs(n - 384711.599)).toBeLessThanOrEqual(0.01);
  });

  it('4326 -> 2039 -> 4326 round trip <= 1e-8°', () => {
    for (const [lng, lat] of [
      [34.78, 32.08],
      [35.0, 29.55],
      [35.75, 33.0],
    ] as const) {
      const { e, n } = toItm(lng, lat);
      const [lng2, lat2] = fromItm(e, n);
      expect(Math.abs(lng2 - lng)).toBeLessThanOrEqual(1e-8);
      expect(Math.abs(lat2 - lat)).toBeLessThanOrEqual(1e-8);
    }
  });
});

describe('itm - GovMap 2022 tile URLs (SPEC section 8.1 L6/L7/L8 vectors)', () => {
  const point = toItm(34.78, 32.08);
  const url = (level: number): string => {
    const { col, row } = itmTileForPoint(point, level);
    return itmTileUrl(level, col, row);
  };

  it('L7 -> .../LPD0BBK2022/L07/R00002534/C00002032.jpg', () => {
    expect(url(7)).toBe('https://cdn.govmap.gov.il/LPD0BBK2022/L07/R00002534/C00002032.jpg');
  });

  it('L8 -> .../L08/R00004a69/C00004065.jpg', () => {
    expect(url(8).endsWith('/L08/R00004a69/C00004065.jpg')).toBe(true);
  });

  it('L6 -> .../L06/R00000ee1/C00000ce1.jpg', () => {
    expect(url(6).endsWith('/L06/R00000ee1/C00000ce1.jpg')).toBe(true);
  });

  it('rejects unknown levels and knows the coverage', () => {
    expect(() => itmTileForPoint(point, 42)).toThrow(RangeError);
    expect(insideItmCoverage(34.78, 32.08)).toBe(true);
    expect(insideItmCoverage(2.35, 48.85)).toBe(false);
  });
});
