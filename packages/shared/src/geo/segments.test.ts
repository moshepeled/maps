import { describe, expect, it } from 'vitest';

import { locatePointInRing, onSegment, orient, segmentRelation, toIntPoint, toPosition } from './segments.js';
import type { IntPoint } from './segments.js';

const p = (x: number, y: number): IntPoint => ({ x, y });

describe('robust orientation', () => {
  it('classifies simple triples', () => {
    expect(orient(p(0, 0), p(10, 0), p(5, 5))).toBe(1);
    expect(orient(p(0, 0), p(10, 0), p(5, -5))).toBe(-1);
    expect(orient(p(0, 0), p(10, 0), p(20, 0))).toBe(0);
  });

  it('decides near-collinear triples exactly where floating point cannot (BigInt fallback)', () => {
    // Coordinates at the extremes of the 1e-7° integer grid: products exceed 2^53.
    const a = p(-1_800_000_000, -850_000_000);
    const b = p(1_800_000_000, 850_000_000);
    const onLine = p(360_000_000, 170_000_000);
    const offByOne = p(360_000_000, 170_000_001);
    expect(orient(a, b, onLine)).toBe(0);
    expect(orient(a, b, offByOne)).toBe(1);
    expect(orient(a, b, p(360_000_000, 169_999_999))).toBe(-1);
  });

  it('converts between degrees and the integer grid', () => {
    expect(toIntPoint([34.78, 32.08])).toEqual({ x: 347_800_000, y: 320_800_000 });
    expect(toPosition({ x: 347_850_000, y: 320_850_000 })).toEqual([34.785, 32.085]);
  });
});

describe('segment relations (closed segments)', () => {
  it('finds proper crossings, touches, overlaps and disjoint pairs', () => {
    expect(segmentRelation(p(0, 0), p(10, 10), p(0, 10), p(10, 0))).toEqual({ kind: 'point', at: p(5, 5) });
    expect(segmentRelation(p(0, 0), p(10, 0), p(5, 0), p(5, 5))).toEqual({ kind: 'point', at: p(5, 0) });
    expect(segmentRelation(p(5, 0), p(5, 5), p(0, 0), p(10, 0))).toEqual({ kind: 'point', at: p(5, 0) });
    expect(segmentRelation(p(0, 0), p(10, 0), p(10, 0), p(10, 5))).toEqual({ kind: 'point', at: p(10, 0) });
    expect(segmentRelation(p(0, 5), p(0, 0), p(-5, 0), p(5, 0))).toEqual({ kind: 'point', at: p(0, 0) });
    expect(segmentRelation(p(0, 0), p(10, 0), p(5, 0), p(15, 0))).toMatchObject({ kind: 'overlap' });
    expect(segmentRelation(p(0, 0), p(10, 0), p(10, 0), p(20, 0))).toEqual({ kind: 'point', at: p(10, 0) });
    expect(segmentRelation(p(0, 0), p(10, 0), p(11, 0), p(20, 0))).toEqual({ kind: 'disjoint' });
    expect(segmentRelation(p(0, 0), p(10, 0), p(0, 1), p(10, 1))).toEqual({ kind: 'disjoint' });
    expect(segmentRelation(p(0, 0), p(10, 10), p(20, 0), p(11, 9))).toEqual({ kind: 'disjoint' });
    expect(onSegment(p(0, 0), p(10, 0), p(11, 0))).toBe(false);
  });
});

describe('point in ring', () => {
  const square = [p(0, 0), p(10, 0), p(10, 10), p(0, 10), p(0, 0)];
  const clockwise = [...square].reverse();

  it('locates inside, outside and boundary points independently of orientation', () => {
    for (const ring of [square, clockwise]) {
      expect(locatePointInRing(p(5, 5), ring)).toBe('inside');
      expect(locatePointInRing(p(15, 5), ring)).toBe('outside');
      expect(locatePointInRing(p(10, 5), ring)).toBe('boundary');
      expect(locatePointInRing(p(0, 0), ring)).toBe('boundary');
      expect(locatePointInRing(p(5, -1), ring)).toBe('outside');
    }
  });
});
