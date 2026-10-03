import type { PolygonGeometry, PolygonGeometryIn } from '@snapland/shared';
import { describe, expect, it } from 'vitest';

import { AppError } from '../../infra/http/errors.js';
import {
  isSameCreate,
  prepareCreate,
  prepareUpdate,
  requireBaseVersion,
  sanitizeDescription,
  sanitizeName,
} from './area-input.js';

const CLOCKWISE_SQUARE: PolygonGeometryIn = {
  type: 'Polygon',
  coordinates: [
    [
      [34.78, 32.08],
      [34.78, 32.089],
      [34.7906, 32.089],
      [34.7906, 32.08],
      [34.78, 32.08],
    ],
  ],
};
const BOWTIE: PolygonGeometryIn = {
  type: 'Polygon',
  coordinates: [
    [
      [34.78, 32.08],
      [34.79, 32.09],
      [34.79, 32.08],
      [34.78, 32.09],
      [34.78, 32.08],
    ],
  ],
};

function codeOf(action: () => unknown): string {
  try {
    action();
  } catch (error) {
    if (error instanceof AppError) return error.code;
    throw error;
  }
  return 'none';
}

describe('text sanitation (section 10.7.1)', () => {
  it('normalises names and rejects empty or too long ones on path "name"', () => {
    expect(sanitizeName('  Rabin ‮Square\t')).toBe('Rabin Square');
    expect(codeOf(() => sanitizeName(' ​ '))).toBe('VALIDATION_FAILED');
    try {
      sanitizeName('x'.repeat(121));
    } catch (error) {
      expect((error as AppError).extensions['errors']).toEqual([
        { path: 'name', code: 'too_long', message: 'name has 121 characters; at most 120 are allowed' },
      ]);
    }
  });

  it('keeps description line breaks and stores an empty description as null', () => {
    expect(sanitizeDescription('a\r\nb')).toBe('a\nb');
    expect(sanitizeDescription('  ')).toBeNull();
    expect(sanitizeDescription(null)).toBeNull();
    expect(sanitizeDescription(undefined)).toBeNull();
    expect(codeOf(() => sanitizeDescription('d'.repeat(2001)))).toBe('VALIDATION_FAILED');
  });
});

describe('prepareCreate / prepareUpdate (section 6.3 step 4 order)', () => {
  it('create: sanitised text and the normalised (counter-clockwise) polygon', () => {
    const input = prepareCreate({ name: ' Park ', description: '', geometry: CLOCKWISE_SQUARE });
    expect(input).toMatchObject({ id: null, name: 'Park', description: null });
    expect(input.geometry.type).toBe('Polygon');
    expect(input.geometry.coordinates[0]?.[1]).toEqual([34.7906, 32.08]);
  });

  it('create: a text failure wins over a geometry failure (400 before 422)', () => {
    expect(codeOf(() => prepareCreate({ name: '', geometry: BOWTIE }))).toBe('VALIDATION_FAILED');
    expect(codeOf(() => prepareCreate({ name: 'ok', geometry: BOWTIE }))).toBe('INVALID_GEOMETRY');
  });

  it('update: sanitation 400 -> missing baseVersion 428 -> geometry 422', () => {
    expect(codeOf(() => prepareUpdate({ name: '', geometry: BOWTIE }))).toBe('VALIDATION_FAILED');
    expect(codeOf(() => prepareUpdate({ name: 'ok', geometry: BOWTIE }))).toBe('PRECONDITION_REQUIRED');
    expect(codeOf(() => prepareUpdate({ baseVersion: 1, geometry: BOWTIE }))).toBe('INVALID_GEOMETRY');
  });

  it('update: only the sent fields are in the patch; revertedFrom is kept', () => {
    expect(prepareUpdate({ baseVersion: 3, description: null, revertedFrom: 1 })).toEqual({
      baseVersion: 3,
      patch: { description: null },
      revertedFrom: 1,
    });
    expect(prepareUpdate({ baseVersion: 2, name: 'n' }).revertedFrom).toBeNull();
  });

  it('requireBaseVersion: absent -> 428', () => {
    expect(requireBaseVersion(4)).toBe(4);
    expect(codeOf(() => requireBaseVersion(undefined))).toBe('PRECONDITION_REQUIRED');
  });
});

describe('isSameCreate (idempotent replay, section 6.3)', () => {
  const input = prepareCreate({ name: 'Park', geometry: CLOCKWISE_SQUARE });
  const snapshot = { createdBy: 'u1', name: 'Park', description: null, geometry: input.geometry };

  it('matches the version-1 snapshot of the same creator', () => {
    expect(isSameCreate(snapshot, input, 'u1')).toBe(true);
    expect(isSameCreate(snapshot, prepareCreate({ name: ' Park ', geometry: CLOCKWISE_SQUARE }), 'u1')).toBe(
      true,
    );
  });

  it('differs on creator, name, description or geometry', () => {
    expect(isSameCreate(snapshot, input, 'u2')).toBe(false);
    expect(isSameCreate({ ...snapshot, name: 'Other' }, input, 'u1')).toBe(false);
    expect(isSameCreate({ ...snapshot, description: 'd' }, input, 'u1')).toBe(false);
    const triangle: PolygonGeometry = {
      type: 'Polygon',
      coordinates: [
        [
          [0, 0],
          [1, 0],
          [1, 1],
          [0, 0],
        ],
      ],
    };
    expect(isSameCreate({ ...snapshot, geometry: triangle }, input, 'u1')).toBe(false);
  });
});
