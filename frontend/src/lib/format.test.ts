import { describe, expect, it } from 'vitest';

import {
  formatAbsoluteTime,
  formatArea,
  formatAreaParts,
  formatAreaSpoken,
  formatCountdown,
  formatDegrees,
  formatHectares,
  formatItmMetres,
  formatPerimeter,
  formatRelativeTime,
  formatShortDate,
  formatSquareMetres,
  roundHalfAway,
} from './format';

describe('UX-AC-13 formatArea / formatHectares / formatCountdown (UX C-06.4, section 9.13)', () => {
  it('UX-AC-13 formatArea: every band of the C-06.4 table', () => {
    expect(formatArea(0.0000004)).toBe('< 1 m²');
    expect(formatArea(0.00998028)).toBe('9,980 m²');
    expect(formatArea(0.99870079)).toBe('0.999 km²');
    expect(formatArea(2.3104)).toBe('2.31 km²');
    expect(formatArea(78.3332672)).toBe('78.33 km²');
    expect(formatArea(1347.46875764)).toBe('1,347.5 km²');
    expect(formatArea(21422.58815494)).toBe('21,423 km²');
  });

  it('UX-AC-13 formatArea chooses the band on the raw value (0.99996 -> 1.000 km²)', () => {
    expect(formatArea(0.99996)).toBe('1.000 km²');
    expect(formatArea(0.000001)).toBe('1 m²');
  });

  it('UX-AC-13 formatHectares: 1.00 ha, 231.0 ha, 2,142,259 ha', () => {
    expect(formatHectares(0.00998)).toBe('1.00 ha');
    expect(formatHectares(2.31)).toBe('231.0 ha');
    expect(formatHectares(21422.58815494)).toBe('2,142,259 ha');
  });

  it('UX-AC-13 formatCountdown: 23 s, 90 s, 15 min', () => {
    expect(formatCountdown(23_000)).toBe('23 s');
    expect(formatCountdown(90_000)).toBe('90 s');
    expect(formatCountdown(873_000)).toBe('15 min');
    expect(formatCountdown(22_100)).toBe('23 s');
    expect(formatCountdown(-5)).toBe('0 s');
  });
});

describe('other formatting helpers', () => {
  it('rounds half away from zero in both directions', () => {
    expect(roundHalfAway(2.5, 0)).toBe(3);
    expect(roundHalfAway(-2.5, 0)).toBe(-3);
    expect(roundHalfAway(-0.0000001, 2)).toBe(0);
  });

  it('spoken areas and exact square metres', () => {
    expect(formatAreaSpoken(2.3104)).toBe('2.31 square kilometers');
    expect(formatAreaSpoken(0.00998028)).toBe('9,980 square meters');
    expect(formatAreaSpoken(0.0000001)).toBe('less than 1 square meter');
    expect(formatSquareMetres(2.3104)).toBe('2,310,400 m²');
  });

  it('perimeter below 1 km in metres, else km with 2 decimals', () => {
    expect(formatPerimeter(0.85)).toBe('850 m');
    expect(formatPerimeter(4.483506686395568)).toBe('4.48 km');
  });

  it('relative and absolute times', () => {
    const now = new Date(2026, 8, 27, 17, 21, 4);
    expect(formatRelativeTime(new Date(now.getTime() - 10_000), now)).toBe('just now');
    expect(formatRelativeTime(new Date(now.getTime() - 5 * 60_000), now)).toBe('5 min ago');
    expect(formatRelativeTime(new Date(now.getTime() - 3 * 3_600_000), now)).toBe('3 h ago');
    expect(formatRelativeTime(new Date(2026, 8, 26, 14, 5), now)).toBe('yesterday at 14:05');
    expect(formatRelativeTime(new Date(2026, 8, 12, 14, 5), now)).toBe('12 Sep 2026, 14:05');
    expect(formatAbsoluteTime(now)).toBe('27 Sep 2026, 17:21:04');
    expect(formatShortDate(new Date(2026, 8, 20), now)).toBe('20 Sep');
    expect(formatShortDate(new Date(2025, 8, 20), now)).toBe('20 Sep 2025');
  });

  it('coordinates: 6-dp degrees and ungrouped 1-dp ITM metres', () => {
    expect(formatDegrees(32.08)).toBe('32.080000');
    expect(formatItmMetres(179383.78389)).toBe('179383.8');
    expect(formatItmMetres(665268.3345)).toBe('665268.3');
  });
});

describe('formatAreaParts (UI.md section 3 instrument readouts)', () => {
  it('splits formatArea into its number and unit, and joins back to it', () => {
    for (const km2 of [0, 0.0000005, 0.004, 0.139, 2.31, 231, 12_345.6, 100_000]) {
      const parts = formatAreaParts(km2);
      expect(`${parts.value} ${parts.unit}`).toBe(formatArea(km2));
    }
    expect(formatAreaParts(1.27)).toEqual({ value: '1.27', unit: 'km²' });
    expect(formatAreaParts(0.004)).toEqual({ value: '4,000', unit: 'm²' });
  });
});
