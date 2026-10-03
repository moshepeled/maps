import { snapBboxToTiles } from '@snapland/shared';
import type { Bbox } from '@snapland/shared';
import { describe, expect, it } from 'vitest';

import { AppError } from '../../infra/http/errors.js';
import {
  decodeBboxCursor,
  decodeVersionCursor,
  encodeBboxCursor,
  encodeVersionCursor,
  queryBinding,
} from './cursor.js';

/** The section 6.3 example: bbox 34.70,31.95,34.95,32.20 at zoom 14, snapped to level 12, limit 1000. */
const EXAMPLE_QUERY_BBOX: Bbox = [34.62890625, 31.877557643340015, 34.98046875, 32.249974455863295];
const EXAMPLE_ID = '7d7a4c52-9a0b-4e0f-b3c1-2e5f6a7b8c9d';
const EXAMPLE_CURSOR =
  'eyJ2IjoxLCJpZCI6IjdkN2E0YzUyLTlhMGItNGUwZi1iM2MxLTJlNWY2YTdiOGM5ZCIsInoiOjE0LCJiIjoiRHFPLVNVQnJhbkZDSlRLdiJ9';
const EXAMPLE = { queryBbox: EXAMPLE_QUERY_BBOX, zoom: 14, limit: 1000 };

function expectInvalidCursor(action: () => unknown): void {
  try {
    action();
  } catch (error) {
    expect(error).toBeInstanceOf(AppError);
    expect((error as AppError).code).toBe('INVALID_CURSOR');
    expect((error as AppError).status).toBe(400);
    return;
  }
  throw new Error('expected INVALID_CURSOR');
}

function encodeRaw(payload: unknown): string {
  return Buffer.from(JSON.stringify(payload)).toString('base64url');
}

describe('bbox cursor (section 5.5 step 4, section 6.3)', () => {
  it('pins the section 6.3 vector: b = DqO-SUBranFCJTKv from the exact float64 queryBbox', () => {
    // The example queryBbox is exactly the level-12 snap of the requested bbox (section 10.2).
    expect(snapBboxToTiles([34.7, 31.95, 34.95, 32.2], 12)).toEqual(EXAMPLE_QUERY_BBOX);
    expect(queryBinding(EXAMPLE)).toBe('DqO-SUBranFCJTKv');
    expect(encodeBboxCursor(EXAMPLE_ID, EXAMPLE)).toBe(EXAMPLE_CURSOR);
    expect(JSON.parse(Buffer.from(EXAMPLE_CURSOR, 'base64url').toString('utf8'))).toEqual({
      v: 1,
      id: EXAMPLE_ID,
      z: 14,
      b: 'DqO-SUBranFCJTKv',
    });
  });

  it('round-trips the id for the query it was issued for', () => {
    expect(decodeBboxCursor(EXAMPLE_CURSOR, EXAMPLE)).toBe(EXAMPLE_ID);
  });

  it.each([
    ['another limit', { ...EXAMPLE, limit: 2000 }],
    ['another zoom', { ...EXAMPLE, zoom: 13 }],
    ['another bbox', { ...EXAMPLE, queryBbox: [34.6, 31.8, 35, 32.3] as Bbox }],
    [
      'rounded display values of the bbox',
      { ...EXAMPLE, queryBbox: [34.628906, 31.877558, 34.980469, 32.249974] as Bbox },
    ],
  ])('rejects a cursor replayed with %s', (_label, query) => {
    expectInvalidCursor(() => decodeBboxCursor(EXAMPLE_CURSOR, query));
  });

  it('rejects a cursor whose zoom was tampered with even when the binding matches', () => {
    const tampered = encodeRaw({ v: 1, id: EXAMPLE_ID, z: 15, b: queryBinding(EXAMPLE) });
    expectInvalidCursor(() => decodeBboxCursor(tampered, EXAMPLE));
  });

  it.each([
    ['not base64 JSON', 'not-a-cursor'],
    ['an empty object', encodeRaw({})],
    ['a wrong version', encodeRaw({ v: 2, id: EXAMPLE_ID, z: 14, b: 'DqO-SUBranFCJTKv' })],
    ['a non-uuid id', encodeRaw({ v: 1, id: 'x', z: 14, b: 'DqO-SUBranFCJTKv' })],
    ['a short binding', encodeRaw({ v: 1, id: EXAMPLE_ID, z: 14, b: 'DqO' })],
    ['an extra key', encodeRaw({ v: 1, id: EXAMPLE_ID, z: 14, b: 'DqO-SUBranFCJTKv', x: 1 })],
    ['a JSON array', encodeRaw([1, 2])],
  ])('rejects %s', (_label, cursor) => {
    expectInvalidCursor(() => decodeBboxCursor(cursor, EXAMPLE));
  });
});

describe('version cursor', () => {
  it('round-trips the last returned version', () => {
    expect(encodeVersionCursor(42)).toBe('42');
    expect(decodeVersionCursor('42')).toBe(42);
    expect(decodeVersionCursor('2147483647')).toBe(2_147_483_647);
  });

  it.each(['0', '-1', '01', '1.5', 'abc', '', '2147483648', '99999999999'])('rejects %j', (cursor) => {
    expectInvalidCursor(() => decodeVersionCursor(cursor));
  });
});
