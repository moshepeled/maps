import type { Bbox } from '@snapland/shared';
import { describe, expect, it } from 'vitest';

import { INTEREST_MARGIN, interestOf, intersectsInterest } from './interest.js';

describe('interestOf (section 7.8: viewport + 50 % on each side)', () => {
  it('expands by half the width and height on every side', () => {
    expect(INTEREST_MARGIN).toBe(0.5);
    const interest = interestOf([34.7, 32.0, 34.9, 32.2]);
    expect(interest[0]).toBeCloseTo(34.6, 10);
    expect(interest[1]).toBeCloseTo(31.9, 10);
    expect(interest[2]).toBeCloseTo(35.0, 10);
    expect(interest[3]).toBeCloseTo(32.3, 10);
  });

  it('clamps to the displayable world', () => {
    const interest = interestOf([-180, -80, 180, 80]);
    expect(interest[0]).toBe(-180);
    expect(interest[2]).toBe(180);
    expect(interest[1]).toBeGreaterThanOrEqual(-85.06);
    expect(interest[3]).toBeLessThanOrEqual(85.06);
  });
});

describe('intersectsInterest', () => {
  const interest: Bbox = [34.6, 31.9, 35.0, 32.3];

  it('is false without a viewport (no spatial events before viewport.set)', () => {
    expect(intersectsInterest(null, [[34.7, 32.0, 34.8, 32.1]])).toBe(false);
  });

  it('matches a box inside or overlapping the interest region', () => {
    expect(intersectsInterest(interest, [[34.7, 32.0, 34.8, 32.1]])).toBe(true);
    expect(intersectsInterest(interest, [[34.9, 32.2, 35.5, 32.9]])).toBe(true);
  });

  it('treats touching boxes as intersecting (closed comparison, like ST_Intersects)', () => {
    expect(intersectsInterest(interest, [[35.0, 32.3, 35.1, 32.4]])).toBe(true);
  });

  it('is false for a box outside the interest region', () => {
    expect(intersectsInterest(interest, [[36.0, 33.0, 36.1, 33.1]])).toBe(false);
  });

  it('matches when any target intersects (new bbox ∪ previous bbox) and skips null targets', () => {
    expect(
      intersectsInterest(interest, [
        [36.0, 33.0, 36.1, 33.1],
        [34.7, 32.0, 34.8, 32.1],
      ]),
    ).toBe(true);
    expect(intersectsInterest(interest, [null, [36.0, 33.0, 36.1, 33.1]])).toBe(false);
    expect(intersectsInterest(interest, [null])).toBe(false);
  });
});
