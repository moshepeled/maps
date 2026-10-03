import type { MergeField, PolygonGeometry } from '@snapland/shared';
import { describe, expect, it } from 'vitest';

import { mergeFieldsOf, mergeState, patchFields, patchValueEquals, planUpdate } from './merge.js';
import type { AreaPatch, MergeCurrent, MergeFields } from './merge.js';

const SQUARE: PolygonGeometry = {
  type: 'Polygon',
  coordinates: [
    [
      [34.78, 32.08],
      [34.7906, 32.08],
      [34.7906, 32.089],
      [34.78, 32.089],
      [34.78, 32.08],
    ],
  ],
};
const BIGGER: PolygonGeometry = {
  type: 'Polygon',
  coordinates: [
    [
      [34.78, 32.08],
      [34.792, 32.08],
      [34.792, 32.09],
      [34.78, 32.09],
      [34.78, 32.08],
    ],
  ],
};
const OTHER: PolygonGeometry = {
  type: 'Polygon',
  coordinates: [
    [
      [34.7, 32.0],
      [34.71, 32.0],
      [34.71, 32.01],
      [34.7, 32.0],
    ],
  ],
};

const V3: MergeFields = { name: 'Rabin Square', description: null, geometry: SQUARE };

function current(overrides: Partial<MergeCurrent> = {}): MergeCurrent {
  return { ...V3, version: 3, ...overrides };
}

function serverChanged(...fields: MergeField[]): ReadonlySet<MergeField> {
  return new Set(fields);
}

describe('planUpdate - section 10.3 scenario matrix', () => {
  it('1: disjoint changes merge (Alice renamed to v4, Bob edits geometry from base 3)', () => {
    const plan = planUpdate({
      current: current({ version: 4, name: 'Renamed by Alice' }),
      baseVersion: 3,
      base: V3,
      serverChanged: serverChanged('name'),
      patch: { geometry: BIGGER },
    });
    expect(plan).toEqual({ kind: 'apply', fields: ['geometry'], merged: true });
  });

  it('2: overlapping geometry edits conflict', () => {
    const plan = planUpdate({
      current: current({ version: 4, geometry: BIGGER }),
      baseVersion: 3,
      base: V3,
      serverChanged: serverChanged('geometry'),
      patch: { geometry: OTHER },
    });
    expect(plan).toEqual({ kind: 'conflict', conflictingFields: ['geometry'] });
  });

  it('3: both rename to the same value -> convergent no-op', () => {
    const plan = planUpdate({
      current: current({ version: 4, name: 'Park' }),
      baseVersion: 3,
      base: V3,
      serverChanged: serverChanged('name'),
      patch: { name: 'Park' },
    });
    expect(plan).toEqual({ kind: 'noop' });
  });

  it('5: a retried PATCH whose first attempt committed is a no-op', () => {
    const plan = planUpdate({
      current: current({ version: 4, geometry: BIGGER }),
      baseVersion: 3,
      base: V3,
      serverChanged: serverChanged('geometry'),
      patch: { geometry: BIGGER },
    });
    expect(plan).toEqual({ kind: 'noop' });
  });

  it('6: of concurrent renames from base 1, the first applies and every later one conflicts', () => {
    const base: MergeFields = { name: 'v1', description: null, geometry: SQUARE };
    const first = planUpdate({
      current: { ...base, version: 1 },
      baseVersion: 1,
      base,
      serverChanged: new Set(),
      patch: { name: 'A' },
    });
    expect(first).toEqual({ kind: 'apply', fields: ['name'], merged: false });
    const second = planUpdate({
      current: { ...base, name: 'A', version: 2 },
      baseVersion: 1,
      base,
      serverChanged: serverChanged('name'),
      patch: { name: 'B' },
    });
    expect(second).toEqual({ kind: 'conflict', conflictingFields: ['name'] });
  });

  it('7: concurrent name and description edits both apply; only the second is merged', () => {
    const base: MergeFields = { name: 'v1', description: null, geometry: SQUARE };
    const nameEdit = planUpdate({
      current: { ...base, version: 1 },
      baseVersion: 1,
      base,
      serverChanged: new Set(),
      patch: { name: 'Named' },
    });
    const descriptionEdit = planUpdate({
      current: { ...base, name: 'Named', version: 2 },
      baseVersion: 1,
      base,
      serverChanged: serverChanged('name'),
      patch: { description: 'Described' },
    });
    expect(nameEdit).toEqual({ kind: 'apply', fields: ['name'], merged: false });
    expect(descriptionEdit).toEqual({ kind: 'apply', fields: ['description'], merged: true });
  });
});

describe('planUpdate - edge cases', () => {
  it('base = current: only the fields that differ are applied, identical ones are dropped', () => {
    const plan = planUpdate({
      current: current(),
      baseVersion: 3,
      base: V3,
      serverChanged: new Set(),
      patch: { name: V3.name, description: 'new', geometry: SQUARE },
    });
    expect(plan).toEqual({ kind: 'apply', fields: ['description'], merged: false });
  });

  it('base = current and nothing differs -> no-op', () => {
    expect(
      planUpdate({
        current: current(),
        baseVersion: 3,
        base: V3,
        serverChanged: new Set(),
        patch: { name: V3.name },
      }),
    ).toEqual({ kind: 'noop' });
  });

  it('a client ahead of the server conflicts on every sent field', () => {
    expect(
      planUpdate({
        current: current(),
        baseVersion: 9,
        base: null,
        serverChanged: new Set(),
        patch: { name: 'x', geometry: BIGGER },
      }),
    ).toEqual({ kind: 'conflict', conflictingFields: ['name', 'geometry'] });
  });

  it('a missing base snapshot is a full conflict', () => {
    expect(
      planUpdate({
        current: current({ version: 5 }),
        baseVersion: 3,
        base: null,
        serverChanged: serverChanged('name'),
        patch: { description: 'd' },
      }),
    ).toEqual({ kind: 'conflict', conflictingFields: ['description'] });
  });

  it('fields the client sent unchanged from its base never override newer server values', () => {
    // The form re-sends the untouched name; the server renamed meanwhile; only the description is applied.
    const plan = planUpdate({
      current: current({ version: 4, name: 'Server name' }),
      baseVersion: 3,
      base: V3,
      serverChanged: serverChanged('name'),
      patch: { name: V3.name, description: 'mine' },
    });
    expect(plan).toEqual({ kind: 'apply', fields: ['description'], merged: true });
  });

  it('a clearing description (null) is a change when the base had text', () => {
    const plan = planUpdate({
      current: current({ version: 4, description: 'text', name: 'n2' }),
      baseVersion: 3,
      base: { ...V3, description: 'text' },
      serverChanged: serverChanged('name'),
      patch: { description: null },
    });
    expect(plan).toEqual({ kind: 'apply', fields: ['description'], merged: true });
  });

  it('geometry equality ignores winding and quantisation noise', () => {
    const ring = SQUARE.coordinates[0] ?? [];
    const clockwise: PolygonGeometry = { type: 'Polygon', coordinates: [[...ring].reverse()] };
    const noisy: PolygonGeometry = {
      type: 'Polygon',
      coordinates: [ring.map(([lng, lat]) => [lng + 1e-9, lat - 1e-9])],
    };
    expect(patchValueEquals({ geometry: clockwise }, V3, 'geometry')).toBe(true);
    expect(patchValueEquals({ geometry: noisy }, V3, 'geometry')).toBe(true);
    expect(patchValueEquals({ geometry: BIGGER }, V3, 'geometry')).toBe(false);
    expect(patchValueEquals({}, V3, 'geometry')).toBe(false);
  });
});

describe('patchFields / mergeState', () => {
  it('keeps only the mergeable changed fields, in canonical order', () => {
    expect(mergeFieldsOf(['geometry', 'deleted', 'name'])).toEqual(['name', 'geometry']);
    expect(mergeFieldsOf(['deleted'])).toEqual([]);
  });

  it('lists the sent fields in canonical order', () => {
    expect(patchFields({ geometry: SQUARE, name: 'n' })).toEqual(['name', 'geometry']);
    expect(patchFields({ description: null })).toEqual(['description']);
    expect(patchFields({})).toEqual([]);
  });

  it('takes only the planned fields from the patch', () => {
    const patch: AreaPatch = { name: 'ignored', description: 'taken', geometry: BIGGER };
    expect(mergeState(V3, patch, ['description', 'geometry'])).toEqual({
      name: V3.name,
      description: 'taken',
      geometry: BIGGER,
    });
    expect(mergeState(V3, { description: null }, ['description'])).toEqual({ ...V3, description: null });
    expect(mergeState(V3, {}, ['name', 'description', 'geometry'])).toEqual(V3);
  });
});
