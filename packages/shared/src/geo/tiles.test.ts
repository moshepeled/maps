import { describe, expect, it } from 'vitest';

import { LIMITS } from '../constants.js';
import { bboxContains, bboxOfPositions, bboxesIntersect, expandBbox } from './bbox.js';
import { lodForZoom } from './lod.js';
import {
  bboxSpanPx,
  snapBboxToTiles,
  tileBounds,
  tileCount,
  tileForPoint,
  tilesCoveringClosed,
  tilesOverlapping,
} from './tiles.js';
import type { Bbox } from './types.js';
import { clampLatitude, metersPerPixel, projectToMercator, unprojectFromMercator } from './webmercator.js';

/** Degrees of longitude covered by one 256-px tile pixel at `zoom`. */
const pixelDeg = (zoom: number): number => 360 / (256 * 2 ** zoom);

describe('webmercator (section 8.1 vectors)', () => {
  it('projects (34.78, 32.08) to x = 3871691.890, y = 3773816.457 (+/-0.01 m)', () => {
    const { x, y } = projectToMercator(34.78, 32.08);
    expect(Math.abs(x - 3871691.89)).toBeLessThan(0.01);
    expect(Math.abs(y - 3773816.457)).toBeLessThan(0.01);
  });

  it('round-trips and clamps latitude to the Mercator limit', () => {
    const [lng, lat] = unprojectFromMercator(3871691.89, 3773816.457);
    expect(lng).toBeCloseTo(34.78, 7);
    expect(lat).toBeCloseTo(32.08, 7);
    expect(clampLatitude(89)).toBe(LIMITS.maxLatitude);
    expect(clampLatitude(-89)).toBe(-LIMITS.maxLatitude);
    expect(projectToMercator(0, 89).y).toBe(projectToMercator(0, LIMITS.maxLatitude).y);
  });

  it('computes the ground resolution', () => {
    expect(metersPerPixel(0, 0)).toBeCloseTo(156543.03392804097, 6);
    expect(metersPerPixel(32.08, 16)).toBeCloseTo(2.024, 3);
  });
});

describe('tiles (section 8.2)', () => {
  it('puts (34.78, 32.08) in the verified GovMap Tel Aviv tile z16/39099/26596', () => {
    expect(tileForPoint(34.78, 32.08, 16)).toEqual({ x: 39099, y: 26596 });
    const [west, south, east, north] = tileBounds(16, 39099, 26596);
    expect(west).toBeLessThanOrEqual(34.78);
    expect(east).toBeGreaterThan(34.78);
    expect(south).toBeLessThan(32.08);
    expect(north).toBeGreaterThanOrEqual(32.08);
  });

  it('clamps tile indexes at the world edges', () => {
    expect(tileForPoint(180, -85.2, 2)).toEqual({ x: 3, y: 3 });
    expect(tileForPoint(-180, 85.2, 2)).toEqual({ x: 0, y: 0 });
  });

  it('snaps the section 6.3 example bbox outward at level 12 to the documented queryBbox (exact doubles)', () => {
    expect(snapBboxToTiles([34.7, 31.95, 34.95, 32.2], 12)).toEqual([
      34.62890625, 31.877557643340015, 34.98046875, 32.249974455863295,
    ]);
  });

  it('uses open overlap for snapping but closed coverage for cache keys (a point on an edge belongs to both tiles)', () => {
    const [west, south, east, north] = tileBounds(10, 600, 400);
    const exactTile: Bbox = [west, south, east, north];
    expect(tilesOverlapping(exactTile, 10)).toEqual({ minX: 600, maxX: 600, minY: 400, maxY: 400 });
    expect(tilesCoveringClosed(exactTile, 10)).toEqual({ minX: 599, maxX: 601, minY: 399, maxY: 401 });
    expect(tileCount(tilesCoveringClosed(exactTile, 10))).toBe(9);
    const inner: Bbox = [west + 0.01, south + 0.01, east - 0.01, north - 0.01];
    expect(tilesCoveringClosed(inner, 10)).toEqual({ minX: 600, maxX: 600, minY: 400, maxY: 400 });
  });

  it('computes the pixel span that the 8,192 px cap bounds (2.8125° at z12, 0.703125° at z14, 0.087890625° at z17)', () => {
    expect(bboxSpanPx([34, 31, 36.8125, 31.5], 12)).toBeCloseTo(8192, 6);
    expect(bboxSpanPx([34, 31.9, 34.703125, 32], 14)).toBeCloseTo(8192, 6);
    expect(bboxSpanPx([34.7, 32.0, 34.787890625, 32.01], 17)).toBeCloseTo(8192, 6);
    // A tall bbox is measured by its height.
    expect(bboxSpanPx([34.7, 30, 34.71, 34], 12)).toBeGreaterThan(8192);
  });
});

describe('lod (section 5.5 table)', () => {
  it('follows the LOD table', () => {
    expect(lodForZoom(5)).toEqual({
      simplifyDeg: 0.5 * pixelDeg(5),
      minExtentDeg: 2 * pixelDeg(5),
      digits: 4,
      simplified: true,
    });
    expect(lodForZoom(12).digits).toBe(5);
    expect(lodForZoom(12).minExtentDeg).toBeCloseTo(6.866e-4, 7);
    expect(lodForZoom(14)).toEqual({
      simplifyDeg: 0.5 * pixelDeg(14),
      minExtentDeg: 0.000171661376953125,
      digits: 6,
      simplified: true,
    });
    expect(lodForZoom(15)).toMatchObject({ minExtentDeg: 0, digits: 6, simplified: true });
    expect(lodForZoom(16).simplifyDeg).toBeGreaterThan(0);
    expect(lodForZoom(17)).toEqual({ simplifyDeg: 0, minExtentDeg: 0, digits: 7, simplified: false });
    expect(lodForZoom(22).digits).toBe(7);
  });
});

describe('bbox helpers', () => {
  it('computes, compares and expands bboxes', () => {
    expect(bboxOfPositions([])).toBeNull();
    expect(
      bboxOfPositions([
        [1, 2],
        [3, -1],
      ]),
    ).toEqual([1, -1, 3, 2]);
    expect(bboxesIntersect([0, 0, 1, 1], [1, 1, 2, 2])).toBe(true);
    expect(bboxesIntersect([0, 0, 1, 1], [1.1, 0, 2, 1])).toBe(false);
    expect(bboxContains([0, 0, 10, 10], [1, 1, 2, 2])).toBe(true);
    expect(bboxContains([0, 0, 10, 10], [1, 1, 12, 2])).toBe(false);
    expect(expandBbox([10, 10, 20, 20], 0.5)).toEqual([5, 5, 25, 25]);
    expect(expandBbox([-179, -85, 179, 85], 0.5)).toEqual([
      -180,
      -LIMITS.maxLatitude,
      180,
      LIMITS.maxLatitude,
    ]);
  });
});
