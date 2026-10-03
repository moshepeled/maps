import { describe, expect, it } from 'vitest';

import { backoffDelayMs, closeCodeFloorMs, isReportableClose, seededRandom } from './backoff';

describe('backoff (SPEC section 7.12 step 1: full jitter over min(30 s, 0.5 s, 2^attempt))', () => {
  it('stays within [0, min(30000, 500, 2^attempt)) for seeded random values', () => {
    const random = seededRandom(7);
    for (let attempt = 1; attempt <= 12; attempt += 1) {
      const ceiling = Math.min(30_000, 500 * 2 ** attempt);
      for (let sample = 0; sample < 50; sample += 1) {
        const delay = backoffDelayMs(attempt, random);
        expect(delay).toBeGreaterThanOrEqual(0);
        expect(delay).toBeLessThan(ceiling);
      }
    }
    expect(backoffDelayMs(3, () => 0.999999)).toBe(3999);
    expect(backoffDelayMs(20, () => 0.5)).toBe(15_000);
  });

  it('is deterministic for a seed', () => {
    const a = seededRandom(123);
    const b = seededRandom(123);
    expect([a(), a(), a()]).toEqual([b(), b(), b()]);
  });

  it('close-code floors and reportable codes (SPEC section 7.11 table)', () => {
    expect(closeCodeFloorMs(1013)).toBe(2000);
    expect(closeCodeFloorMs(4400)).toBe(10_000);
    expect(closeCodeFloorMs(4429)).toBe(10_000);
    expect(closeCodeFloorMs(1006)).toBe(0);
    expect(isReportableClose(1003)).toBe(true);
    expect(isReportableClose(1009)).toBe(true);
    expect(isReportableClose(4400)).toBe(true);
    expect(isReportableClose(1006)).toBe(false);
  });
});
