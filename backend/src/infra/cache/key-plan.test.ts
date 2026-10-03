import { tileBounds, tileCount, tilesCoveringClosed } from '@snapland/shared';
import type { Bbox } from '@snapland/shared';
import { describe, expect, it } from 'vitest';

import {
  cacheKeyHash,
  cacheKeyMaterial,
  cacheLevelForZoom,
  keyTiles,
  planBboxQuery,
  randomEpoch,
  tilesToInvalidate,
} from './key-plan.js';
import type { GenerationSnapshot } from './key-plan.js';

const TEL_AVIV: Bbox = [34.7, 31.95, 34.95, 32.2];

describe('cache levels and bypass (section 10.2 steps 1-2)', () => {
  it('uses L = clamp(zoom − 2, 0, 14) and bypasses zoom >= 17', () => {
    expect(cacheLevelForZoom(0)).toBe(0);
    expect(cacheLevelForZoom(1)).toBe(0);
    expect(cacheLevelForZoom(14)).toBe(12);
    expect(cacheLevelForZoom(16)).toBe(14);
    expect(cacheLevelForZoom(17)).toBeNull();
    expect(planBboxQuery([34.78, 32.08, 34.79, 32.09], 18)).toEqual({
      zoom: 18,
      level: null,
      queryBbox: [34.78, 32.08, 34.79, 32.09],
      tiles: null,
    });
  });

  it('snaps the section 6.3 example to the documented queryBbox at zoom 14 (level 12)', () => {
    const plan = planBboxQuery(TEL_AVIV, 14);
    expect(plan.level).toBe(12);
    expect(plan.queryBbox).toEqual([34.62890625, 31.877557643340015, 34.98046875, 32.249974455863295]);
    expect(plan.tiles).toEqual(tilesCoveringClosed(plan.queryBbox, 12));
  });

  it('bypasses a plan whose closed key coverage exceeds 64 tiles', () => {
    const wide: Bbox = [30, 25, 38, 33];
    const plan = planBboxQuery(wide, 14);
    expect(plan.level).toBeNull();
    expect(plan.queryBbox).toEqual(wide);
    expect(keyTiles(plan)).toEqual([]);
  });

  it('gives a polygon touching the snapped east and south edges a key tile in common with the reader (closed coverage)', () => {
    const plan = planBboxQuery(TEL_AVIV, 14);
    const level = plan.level ?? -1;
    const [, south, east] = plan.queryBbox;
    // A polygon that only touches the corner (east, south) of the snapped bbox.
    const touching: Bbox = [east, south - 0.01, east + 0.01, south];
    const readerTiles = new Set(keyTiles(plan).map((tile) => `${tile.x}:${tile.y}`));
    const writer = tilesToInvalidate(touching).find((target) => target.level === level);
    if (writer === undefined || writer.tiles === 'big') throw new Error('expected per-tile invalidation');
    const written: string[] = [];
    for (let y = writer.tiles.minY; y <= writer.tiles.maxY; y += 1) {
      for (let x = writer.tiles.minX; x <= writer.tiles.maxX; x += 1) written.push(`${x}:${y}`);
    }
    expect(written.some((tile) => readerTiles.has(tile))).toBe(true);
  });
});

describe('invalidation targets (section 10.2 step 5)', () => {
  it('covers levels 0...14, bumping "big" when more than 16 tiles would be touched', () => {
    const small: Bbox = [34.78, 32.08, 34.79, 32.09];
    const targets = tilesToInvalidate(small);
    expect(targets.map((target) => target.level)).toEqual([
      ...Array.from({ length: 15 }, (_, level) => level),
    ]);
    expect(targets.every((target) => target.tiles !== 'big')).toBe(true);
    const large: Bbox = [30, 25, 36, 31];
    const levels = tilesToInvalidate(large);
    expect(levels.find((target) => target.level === 14)?.tiles).toBe('big');
    const level0 = levels.find((target) => target.level === 0)?.tiles;
    expect(level0 !== 'big' && level0 !== undefined && tileCount(level0) <= 16).toBe(true);
  });

  it('includes both neighbours of an edge the bbox lies on', () => {
    const [west, south, east, north] = tileBounds(10, 600, 400);
    const onWestEdge: Bbox = [west, south + 0.01, west + 0.001, north - 0.01];
    const level10 = tilesToInvalidate(onWestEdge).find((target) => target.level === 10)?.tiles;
    expect(level10).toEqual({ minX: 599, maxX: 600, minY: 400, maxY: 400 });
    expect(east).toBeGreaterThan(west);
  });
});

describe('cache keys (section 10.2 step 4)', () => {
  const plan = planBboxQuery(TEL_AVIV, 14);
  const key = { plan, limit: 2000, cursor: null };
  const generations: GenerationSnapshot = { epoch: '12345', big: 0, tiles: keyTiles(plan).map(() => 0) };

  it('contains version, level, zoom, limit, cursor, queryBbox, epoch, big and every tile generation', () => {
    const material = cacheKeyMaterial(key, generations);
    expect(material.startsWith(`v1|12|14|2000||${plan.queryBbox.join(',')}|12345|0|`)).toBe(true);
    expect(material).toContain(`${keyTiles(plan)[0]?.x}:${keyTiles(plan)[0]?.y}=0`);
    expect(cacheKeyHash(key, generations)).toMatch(/^[0-9a-f]{40}$/);
  });

  it('changes with the epoch (a Redis restart can never match old bodies), a generation, the cursor or the limit', () => {
    const base = cacheKeyHash(key, generations);
    expect(cacheKeyHash(key, { ...generations, epoch: '99' })).not.toBe(base);
    expect(cacheKeyHash(key, { ...generations, big: 1 })).not.toBe(base);
    expect(
      cacheKeyHash(key, {
        ...generations,
        tiles: generations.tiles.map((gen, index) => (index === 0 ? gen + 1 : gen)),
      }),
    ).not.toBe(base);
    expect(cacheKeyHash({ ...key, cursor: 'abc' }, generations)).not.toBe(base);
    expect(cacheKeyHash({ ...key, limit: 1000 }, generations)).not.toBe(base);
    expect(cacheKeyHash(key, { ...generations, tiles: [] })).toBe(
      cacheKeyHash(key, { ...generations, tiles: generations.tiles.map(() => 0) }),
    );
  });

  it('draws random 52-bit epochs', () => {
    expect(randomEpoch(() => 0)).toBe('0');
    expect(Number(randomEpoch(() => 0.999999))).toBeLessThan(2 ** 52);
    expect(Number.isSafeInteger(Number(randomEpoch()))).toBe(true);
    expect(cacheKeyMaterial({ ...key, plan: planBboxQuery(TEL_AVIV, 18) }, generations)).toContain(
      '|bypass|18|',
    );
  });
});
