import { describe, expect, it } from 'vitest';

import { validFixture } from '../testing/fixtures.js';
import {
  applyRfc7946Winding,
  dedupeConsecutive,
  normalizePolygon,
  orientRing,
  polygonsEqual,
  quantizeAndDedupe,
  samePosition,
  signedRingArea2,
} from './normalize.js';
import { COMMITTED_DECIMALS, DRAFT_DECIMALS, quantize, quantizePosition } from './precision.js';
import type { Position } from './types.js';

describe('quantize (half away from zero, section 8.7)', () => {
  it('rounds halves away from zero in both directions', () => {
    expect(quantize(2.5, 0)).toBe(3);
    expect(quantize(-2.5, 0)).toBe(-3);
    expect(quantize(0.125, 2)).toBe(0.13);
    expect(quantize(-0.125, 2)).toBe(-0.13);
  });

  it('is sign-symmetric at 7 dp for +/-x.xxxxxxx5 in all four quadrants (Sydney and Fiji fixtures)', () => {
    const sydney = validFixture('southern_hemisphere_sydney').geojson.coordinates[0]?.[0] ?? [0, 0];
    const fiji = validFixture('near_antimeridian_fiji').geojson.coordinates[0]?.[0] ?? [0, 0];
    for (const [lng, lat] of [sydney, fiji]) {
      for (const value of [lng + 0.00000005, lat - 0.00000005, -lng - 0.00000005, -lat + 0.00000005]) {
        expect(quantize(-value, COMMITTED_DECIMALS)).toBe(-quantize(value, COMMITTED_DECIMALS));
      }
    }
  });

  it('is idempotent and never returns -0', () => {
    for (const value of [34.78000004999, -33.8650000501, 179.95, -0.00000001]) {
      const once = quantize(value, COMMITTED_DECIMALS);
      expect(quantize(once, COMMITTED_DECIMALS)).toBe(once);
    }
    expect(Object.is(quantize(-0.00000001, COMMITTED_DECIMALS), 0)).toBe(true);
    expect(Object.is(quantize(-0, 3), 0)).toBe(true);
  });

  it('quantises positions (drafts to 6 dp)', () => {
    expect(quantizePosition([34.7812345, 32.0812345], DRAFT_DECIMALS)).toEqual([34.781235, 32.081235]);
  });
});

describe('normalisation (section 9.2 stages 5 and 11)', () => {
  const clockwise: Position[] = [
    [0, 0],
    [0, 1],
    [1, 1],
    [1, 0],
    [0, 0],
  ];

  it('removes consecutive duplicates and keeps the closing position', () => {
    expect(
      dedupeConsecutive([
        [0, 0],
        [0, 0],
        [1, 0],
        [1, 1],
        [1, 1],
        [0, 0],
      ]),
    ).toEqual([
      [0, 0],
      [1, 0],
      [1, 1],
      [0, 0],
    ]);
    expect(dedupeConsecutive([])).toEqual([]);
  });

  it('winds the exterior counter-clockwise and holes clockwise without mutating the input', () => {
    const copy = clockwise.map((p): Position => [p[0], p[1]]);
    expect(signedRingArea2(clockwise)).toBeLessThan(0);
    expect(signedRingArea2(orientRing(clockwise, true))).toBeGreaterThan(0);
    expect(orientRing(orientRing(clockwise, true), true)).toEqual(orientRing(clockwise, true));
    expect(clockwise).toEqual(copy);
    const [exterior, hole] = applyRfc7946Winding([clockwise, orientRing(clockwise, true)]);
    expect(signedRingArea2(exterior ?? [])).toBeGreaterThan(0);
    expect(signedRingArea2(hole ?? [])).toBeLessThan(0);
  });

  it('normalises and compares polygons exactly at 7 dp', () => {
    const noisy = [
      [
        [0.00000001, 0],
        [0, 1],
        [0, 1],
        [1, 1],
        [1, 0],
        [0.00000001, 0],
      ],
    ];
    expect(quantizeAndDedupe(noisy)[0]).toHaveLength(5);
    expect(normalizePolygon(noisy)).toEqual([orientRing(clockwise, true)]);
    expect(polygonsEqual(noisy, [clockwise])).toBe(true);
    expect(polygonsEqual([clockwise], [clockwise, clockwise])).toBe(false);
    expect(
      polygonsEqual(
        [clockwise],
        [
          [
            [0, 0],
            [2, 0],
            [2, 2],
            [0, 0],
          ],
        ],
      ),
    ).toBe(false);
    expect(
      polygonsEqual(
        [clockwise],
        [
          [
            [0, 0],
            [0, 1],
            [1, 1.5],
            [1, 0],
            [0, 0],
          ],
        ],
      ),
    ).toBe(false);
    expect(samePosition([1, 2], [1, 2])).toBe(true);
  });
});
