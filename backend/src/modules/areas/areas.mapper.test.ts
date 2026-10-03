import { ChangeEventDtoSchema } from '@snapland/shared';
import { describe, expect, it } from 'vitest';

import { toChangeEventDto } from './areas.mapper.js';
import type { ChangeRow } from './areas.mapper.js';

const ALICE = { id: '3f6c1a2e-0b1d-4c55-9a0e-7c1d2b3a4f50', displayName: 'Alice', color: '#c44f9d' };
const BOB = { id: '5a1f9c3e-7b2d-4e6f-8a1b-2c3d4e5f6a7b', displayName: 'Bob', color: '#b86e3d' };

/** An update by Alice (version 5) of an area Bob created. */
function change(overrides: Partial<ChangeRow> = {}): ChangeRow {
  return {
    change_seq: 1044,
    op: 'update',
    area_id: '7d7a4c52-9a0b-4e0f-b3c1-2e5f6a7b8c9d',
    version: 5,
    name: 'Rabin Square',
    description: 'd',
    geometry: {
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
    },
    area_km2: 1,
    perimeter_km: 4,
    vertex_count: 4,
    changed_fields: ['geometry'],
    merged: true,
    created_at: new Date('2026-09-27T10:05:00.000Z'),
    bbox: [34.78, 32.08, 34.7906, 32.089],
    actor_id: ALICE.id,
    actor_name: ALICE.displayName,
    actor_color: ALICE.color,
    created_by: BOB.id,
    created_by_name: BOB.displayName,
    created_by_color: BOB.color,
    area_created_at: new Date('2026-09-27T09:00:00.000Z'),
    ...overrides,
  };
}

describe('the area as of one change (change feed, section 6.3)', () => {
  it("an update: the version's actor is updatedBy, the area's creator stays createdBy, nothing is deleted", () => {
    const dto = toChangeEventDto(change());
    expect(ChangeEventDtoSchema.parse(dto)).toEqual(dto);
    expect(dto.actor).toEqual(ALICE);
    expect(dto.area).toMatchObject({
      version: 5,
      createdBy: BOB,
      updatedBy: ALICE,
      createdAt: '2026-09-27T09:00:00.000Z',
      updatedAt: '2026-09-27T10:05:00.000Z',
      deletedAt: null,
      deletedBy: null,
    });
  });

  it('a delete is a tombstone: deletedAt is the change time and deletedBy its actor', () => {
    const { area } = toChangeEventDto(change({ op: 'delete', changed_fields: ['deleted'] }));
    expect(area.deletedAt).toBe('2026-09-27T10:05:00.000Z');
    expect(area.deletedBy).toEqual(ALICE);
  });

  it('falls back to the creator when the actor is unknown', () => {
    const dto = toChangeEventDto(
      change({ op: 'delete', actor_id: null, actor_name: null, actor_color: null }),
    );
    expect(dto.actor).toBeNull();
    expect(dto.area.updatedBy).toEqual(BOB);
    expect(dto.area.deletedBy).toEqual(BOB);
  });
});
