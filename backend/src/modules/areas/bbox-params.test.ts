import { LIMITS, bboxSpanPx } from '@snapland/shared';
import { describe, expect, it } from 'vitest';

import { AppError } from '../../infra/http/errors.js';
import { parseBboxParam } from './bbox-params.js';

function invalidBboxDetail(raw: string, zoom: number): string {
  try {
    parseBboxParam(raw, zoom);
  } catch (error) {
    expect(error).toBeInstanceOf(AppError);
    const appError = error as AppError;
    expect(appError.code).toBe('INVALID_BBOX');
    expect(appError.status).toBe(400);
    return appError.detail;
  }
  throw new Error(`expected ${raw} at zoom ${zoom} to be rejected`);
}

describe('parseBboxParam (section 5.5 bbox parameter rules)', () => {
  it('parses four finite numbers in west,south,east,north order', () => {
    expect(parseBboxParam('34.70,31.95,34.95,32.20', 14)).toEqual([34.7, 31.95, 34.95, 32.2]);
    expect(parseBboxParam('-0.5,-.25,+0.5,1e-1', 10)).toEqual([-0.5, -0.25, 0.5, 0.1]);
  });

  it.each([
    ['34.7,31.95,34.95', 'got 3 value(s)'],
    ['34.7,31.95,34.95,32.2,1', 'got 5 value(s)'],
    ['', 'got 1 value(s)'],
  ])('rejects %j (not exactly four values)', (raw, fragment) => {
    expect(invalidBboxDetail(raw, 14)).toContain(fragment);
  });

  it.each([
    'abc,31.95,34.95,32.2',
    '34.7,,34.95,32.2',
    '34.7, 31.95,34.95,32.2',
    '0x10,31.95,34.95,32.2',
    'Infinity,31.95,34.95,32.2',
    'NaN,31.95,34.95,32.2',
    '1e999,31.95,34.95,32.2',
    '34.7,31.95,34.95,32_2',
  ])('rejects the non-numeric or non-finite value in %j', (raw) => {
    expect(invalidBboxDetail(raw, 14)).toContain('must be a finite number');
  });

  it.each([
    ['-180.0001,0,-179.9,0.1', 'longitudes'],
    ['179.9,0,180.0001,0.1', 'longitudes'],
    ['34.7,86,34.8,86.1', 'latitudes'],
    ['34.7,-85.06,34.8,-85', 'latitudes'],
  ])('rejects out-of-range %j', (raw, fragment) => {
    expect(invalidBboxDetail(raw, 17)).toContain(fragment);
  });

  it('accepts the exact range limits', () => {
    expect(parseBboxParam(`-180,-${LIMITS.maxLatitude},180,${LIMITS.maxLatitude}`, 0)).toEqual([
      -180,
      -LIMITS.maxLatitude,
      180,
      LIMITS.maxLatitude,
    ]);
  });

  it.each([
    ['34.95,31.95,34.7,32.2', 'west must be less than east'],
    ['34.7,31.95,34.7,32.2', 'west must be less than east'],
    ['34.7,32.2,34.95,31.95', 'south must be less than north'],
    ['34.7,32.2,34.95,32.2', 'south must be less than north'],
  ])('rejects the inverted or empty bbox %j', (raw, fragment) => {
    expect(invalidBboxDetail(raw, 12)).toContain(fragment);
  });

  describe('span cap (LIMITS.bboxMaxSpanPx = 8,192 px at the requested zoom)', () => {
    it('rejects the world at zoom 17 (the abuse path the cap removes)', () => {
      expect(invalidBboxDetail('-180,-85,180,85', 17)).toContain('at most 8192 px');
    });

    it.each([
      [12, 2.81, 2.82],
      [14, 0.703, 0.704],
      [17, 0.0878, 0.088],
    ])('zoom %i: %f° wide passes, %f° wide fails', (zoom, allowedWidth, rejectedWidth) => {
      const south = 32.08;
      const north = 32.081;
      const allowed = `34.7,${south},${34.7 + allowedWidth},${north}`;
      const rejected = `34.7,${south},${34.7 + rejectedWidth},${north}`;
      expect(parseBboxParam(allowed, zoom)[2]).toBeCloseTo(34.7 + allowedWidth, 9);
      expect(invalidBboxDetail(rejected, zoom)).toContain(`at zoom ${zoom}`);
    });

    it('caps the Mercator height as well as the width', () => {
      // Near 32°N one degree of latitude spans ~ 1.18 x the pixels of one degree of longitude.
      expect(bboxSpanPx([34.7, 31, 34.71, 33], 12)).toBeLessThan(LIMITS.bboxMaxSpanPx);
      expect(parseBboxParam('34.7,31,34.71,33', 12)).toEqual([34.7, 31, 34.71, 33]);
      expect(invalidBboxDetail('34.7,30.5,34.71,33', 12)).toContain('at zoom 12');
    });

    it('allows the world at zoom 0 to 5', () => {
      for (const zoom of [0, 1, 2, 3, 4, 5]) {
        expect(parseBboxParam('-180,-85,180,85', zoom)).toEqual([-180, -85, 180, 85]);
      }
    });
  });
});
