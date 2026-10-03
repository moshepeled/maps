import type { Position } from '@snapland/shared';
import { describe, expect, it } from 'vitest';

import {
  closeRing,
  cycleSelection,
  deletePoint,
  edgeMidpoint,
  editMetrics,
  insertPoint,
  isDirty,
  movePoint,
  openRing,
  ringProblem,
  selectPoint,
  startEdit,
  undoEdit,
} from './editReducer';

const SQUARE: Position[] = [
  [34.78, 32.08],
  [34.79, 32.08],
  [34.79, 32.09],
  [34.78, 32.09],
  [34.78, 32.08],
];

function edit() {
  return startEdit({ areaId: 'a', name: 'North Field', version: 4, exterior: SQUARE });
}

describe('editReducer (UX F-04, C-12)', () => {
  it('opens the ring and computes the baseline area', () => {
    const state = edit();
    expect(state.points).toHaveLength(4);
    expect(state.originalAreaKm2).toBeGreaterThan(0.9);
    expect(isDirty(state)).toBe(false);
    expect(closeRing(state.points)).toHaveLength(5);
    expect(openRing(state.points)).toHaveLength(4);
  });

  it('moving a point is committed to the undo stack; undo restores it', () => {
    const moved = movePoint(edit(), 2, [34.795, 32.095]);
    expect(moved.points[2]).toEqual([34.795, 32.095]);
    expect(isDirty(moved)).toBe(true);
    expect(editMetrics(moved.points).areaKm2).toBeGreaterThan(edit().originalAreaKm2);
    const undone = undoEdit(moved);
    expect(undone.points).toEqual(edit().points);
    expect(undoEdit(undone)).toBe(undone);
  });

  it('UX-AC-33 rule: a move that makes edges cross snaps back with reverted-crossing', () => {
    const state = movePoint(edit(), 0, [34.795, 32.085]);
    expect(state.points).toEqual(edit().points);
    expect(state.refusal).toBe('reverted-crossing');
  });

  it('inserting at a midpoint adds a point and selects it; deleting refuses at 3 points', () => {
    const base = edit();
    const mid = edgeMidpoint(base.points, 0);
    expect(mid).toEqual([34.785, 32.08]);
    const inserted = insertPoint(base, 0, [34.785, 32.075]);
    expect(inserted.points).toHaveLength(5);
    expect(inserted.selected).toBe(1);
    const deleted = deletePoint(inserted, 1);
    expect(deleted.points).toHaveLength(4);
    const triangle = deletePoint(deleted, 0);
    expect(triangle.points).toHaveLength(3);
    expect(deletePoint(triangle, 0).refusal).toBe('min-points');
  });

  it('refuses a delete that would make edges cross', () => {
    // A deep notch: vertex E sits inside the triangle B-C-D, so removing C makes B->D cross E->A.
    const notched = startEdit({
      areaId: 'b',
      name: 'Notch',
      version: 1,
      exterior: [
        [34.7, 32.0],
        [34.8, 32.0],
        [34.8, 32.1],
        [34.7, 32.1],
        [34.77, 32.07],
        [34.7, 32.0],
      ],
    });
    expect(ringProblem(notched.points)).toBeNull();
    const result = deletePoint(notched, 2);
    expect(result.points).toHaveLength(5);
    expect(result.refusal).toBe('delete-would-cross');
  });

  it('cycles the selection with ] and [', () => {
    const state = edit();
    expect(cycleSelection(state, 1).selected).toBe(0);
    expect(cycleSelection(state, -1).selected).toBe(3);
    expect(cycleSelection(selectPoint(state, 3), 1).selected).toBe(0);
    expect(selectPoint(state, 99)).toBe(state);
  });

  it('a too-large result is refused with too-large', () => {
    const state = startEdit({
      areaId: 'c',
      name: 'Big',
      version: 1,
      exterior: [
        [0, 0],
        [5, 0],
        [5, 5],
        [0, 5],
        [0, 0],
      ],
    });
    const result = movePoint(state, 2, [15, 15]);
    expect(result.refusal).toBe('too-large');
  });
});
