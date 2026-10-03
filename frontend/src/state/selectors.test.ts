import { describe, expect, it } from 'vitest';

import { ALICE, BOB, listItem, uuid } from '../test/factories';
import type { AreaRecord } from './areasStore';
import { recordFromListItem } from './areasStore';
import { areasInView, canDelete, drawOrder, matchesFilter, sortAreas, viewportSummary } from './selectors';

function record(
  n: number,
  west: number,
  south: number,
  areaKm2: number,
  name: string,
  updatedAt: string,
): AreaRecord {
  return {
    ...recordFromListItem(listItem({ id: uuid(n), west, south, size: 0.01, name }), 6),
    areaKm2,
    updatedAt,
  };
}

const AREAS = [
  record(1, 34.78, 32.08, 1.25, 'North Field', '2026-09-27T10:00:00.000Z'),
  record(2, 34.8, 32.1, 0.5, 'Émek', '2026-09-27T11:00:00.000Z'),
  record(3, 10, 10, 7, 'Far away', '2026-09-27T09:00:00.000Z'),
];

describe('selectors (SPEC section 8.5 analysis, UX C-10)', () => {
  it('viewportSummary counts loaded areas intersecting the viewport and sums their stored km²', () => {
    expect(viewportSummary(AREAS, [34.7, 32.0, 34.9, 32.2])).toEqual({ count: 2, totalKm2: 1.75 });
    expect(viewportSummary(AREAS, [0, 0, 1, 1])).toEqual({ count: 0, totalKm2: 0 });
    expect(viewportSummary(AREAS, null)).toEqual({ count: 0, totalKm2: 0 });
    // Touching the viewport edge counts (closed intersection, like the server).
    const north = AREAS[0]?.bbox ?? [0, 0, 0, 0];
    expect(
      areasInView(AREAS, [north[2], north[3], north[2] + 0.001, north[3] + 0.001]).map((area) => area.name),
    ).toEqual(['North Field']);
  });

  it('filters case- and diacritic-insensitively', () => {
    expect(matchesFilter('Émek', 'emek')).toBe(true);
    expect(matchesFilter('North Field', 'FIELD')).toBe(true);
    expect(matchesFilter('North Field', 'south')).toBe(false);
    expect(matchesFilter('anything', '  ')).toBe(true);
  });

  it('sorts by recent edit, name and size', () => {
    expect(sortAreas(AREAS, 'recent').map((area) => area.name)).toEqual(['Émek', 'North Field', 'Far away']);
    expect(sortAreas(AREAS, 'name').map((area) => area.name)).toEqual(['Émek', 'Far away', 'North Field']);
    expect(sortAreas(AREAS, 'size').map((area) => area.name)).toEqual(['Far away', 'North Field', 'Émek']);
  });

  it('canDelete: creator (from createdBy, else createdById) or admin', () => {
    const area = { createdById: ALICE.id };
    expect(canDelete({ id: ALICE.id, role: 'user' }, area)).toBe(true);
    expect(canDelete({ id: BOB.id, role: 'user' }, area)).toBe(false);
    expect(canDelete({ id: BOB.id, role: 'admin' }, area)).toBe(true);
    expect(canDelete({ id: BOB.id, role: 'user' }, { createdById: ALICE.id, createdBy: BOB })).toBe(true);
    expect(canDelete(null, area)).toBe(false);
  });

  it('draws larger areas first so nested small ones stay on top', () => {
    expect(drawOrder(AREAS).map((area) => area.areaKm2)).toEqual([7, 1.25, 0.5]);
  });
});
