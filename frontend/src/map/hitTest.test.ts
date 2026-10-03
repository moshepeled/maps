import type { Position } from '@snapland/shared';
import { describe, expect, it } from 'vitest';

import { bboxOf, squareRing } from '../test/factories';
import type { HitCandidate } from './hitTest';
import { hitTest, polygonContains } from './hitTest';

function square(
  id: string,
  west: number,
  south: number,
  size: number,
  holes: Position[][] = [],
): HitCandidate {
  return {
    id,
    bbox: bboxOf(west, south, size),
    rings: [squareRing(west, south, size), ...holes],
    areaKm2: size * size * 12_000,
  };
}

describe('hitTest (UX C-08, UX-AC-108)', () => {
  const large = square('L', 34.7, 32.0, 0.1);
  const small = square('S', 34.74, 32.04, 0.01);

  it('UX-AC-108 clicking inside the nested small area selects it whatever the order, outside it selects the large one', () => {
    expect(hitTest([large, small], [34.745, 32.045])?.id).toBe('S');
    expect(hitTest([small, large], [34.745, 32.045])?.id).toBe('S');
    expect(hitTest([large, small], [34.71, 32.01])?.id).toBe('L');
  });

  it('misses outside every area and inside a hole', () => {
    const ring = square('H', 34.8, 32.1, 0.1, [squareRing(34.82, 32.12, 0.02)]);
    expect(hitTest([large], [35.5, 31.0])).toBeNull();
    expect(hitTest([ring], [34.83, 32.13])).toBeNull();
    expect(hitTest([ring], [34.81, 32.11])?.id).toBe('H');
  });

  it('the boundary counts as inside', () => {
    expect(polygonContains(large.rings, [34.7, 32.05])).toBe(true);
    expect(polygonContains([[[0, 0]]], [0, 0])).toBe(false);
  });
});
