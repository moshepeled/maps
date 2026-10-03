/**
 * Shape editing of an existing area (UX F-04, C-12) as pure transitions over lat/lng points: move, insert at a
 * midpoint, delete, undo. Every committed change is validated with the shared validator on the closed ring; an
 * invalid move snaps back (UX-AC-33) and an invalid delete is refused.
 */
import type { Position } from '@snapland/shared';
import {
  COMMITTED_DECIMALS,
  geodesicArea,
  geodesicPerimeter,
  quantizePosition,
  validatePolygon,
} from '@snapland/shared';

import type { DrawingLimits } from './drawingReducer';
import { DEFAULT_DRAWING_LIMITS } from './drawingReducer';

/** Why an edit operation was refused (maps to `edit.*` copy and `hud-message[data-code]`). */
export type EditRefusal =
  'reverted-crossing' | 'too-large' | 'min-points' | 'delete-would-cross' | 'max-points';

export interface EditState {
  areaId: string;
  name: string;
  baseVersion: number;
  /** The exterior ring as loaded (open, 7 dp): the "(was ...)" baseline and the Cancel target. */
  original: Position[];
  originalAreaKm2: number;
  points: Position[];
  selected: number | null;
  moveArmed: boolean;
  undoStack: Position[][];
  refusal: EditRefusal | null;
}

export function openRing(ring: readonly Position[]): Position[] {
  const first = ring[0];
  const last = ring.at(-1);
  const closed = ring.length > 1 && first?.[0] === last?.[0] && first?.[1] === last?.[1];
  return (closed ? ring.slice(0, -1) : [...ring]).map((point) => quantizePosition(point, COMMITTED_DECIMALS));
}

export function closeRing(points: readonly Position[]): Position[] {
  const first = points[0];
  return first === undefined ? [] : [...points, first];
}

export function startEdit(input: {
  areaId: string;
  name: string;
  version: number;
  exterior: readonly Position[];
}): EditState {
  const points = openRing(input.exterior);
  return {
    areaId: input.areaId,
    name: input.name,
    baseVersion: input.version,
    original: points,
    originalAreaKm2: geodesicArea([points]),
    points,
    selected: null,
    moveArmed: false,
    undoStack: [],
    refusal: null,
  };
}

/** Validation of a candidate ring: the refusal code, or null when the ring is savable. */
export function ringProblem(
  points: readonly Position[],
  limits: DrawingLimits = DEFAULT_DRAWING_LIMITS,
): 'crossing' | 'too-large' | null {
  const result = validatePolygon({ type: 'Polygon', coordinates: [closeRing(points)] });
  if (!result.ok) return result.issues[0]?.code === 'AREA_TOO_LARGE' ? 'too-large' : 'crossing';
  return result.areaKm2 > limits.maxAreaKm2 ? 'too-large' : null;
}

function commit(state: EditState, points: Position[], selected: number | null): EditState {
  return { ...state, points, selected, undoStack: [...state.undoStack, state.points], refusal: null };
}

/** Moves point `index` (drag release, keyboard, *Move point*); an invalid result snaps back (UX-AC-33). */
export function movePoint(
  state: EditState,
  index: number,
  position: Position,
  limits: DrawingLimits = DEFAULT_DRAWING_LIMITS,
): EditState {
  if (index < 0 || index >= state.points.length) return state;
  const points = state.points.map((point, i) =>
    i === index ? quantizePosition(position, COMMITTED_DECIMALS) : point,
  );
  const problem = ringProblem(points, limits);
  if (problem !== null) {
    return {
      ...state,
      moveArmed: false,
      refusal: problem === 'too-large' ? 'too-large' : 'reverted-crossing',
    };
  }
  return { ...commit(state, points, index), moveArmed: false };
}

/** Inserts a point after `edgeIndex` (a midpoint click or `I`); it becomes selected. */
export function insertPoint(
  state: EditState,
  edgeIndex: number,
  position: Position,
  limits: DrawingLimits = DEFAULT_DRAWING_LIMITS,
): EditState {
  if (state.points.length + 1 > limits.maxPoints) return { ...state, refusal: 'max-points' };
  const points = [...state.points];
  points.splice(edgeIndex + 1, 0, quantizePosition(position, COMMITTED_DECIMALS));
  if (ringProblem(points, limits) !== null) return { ...state, refusal: 'reverted-crossing' };
  return commit(state, points, edgeIndex + 1);
}

/** The midpoint of edge `edgeIndex` (for `I` and midpoint handles). */
export function edgeMidpoint(points: readonly Position[], edgeIndex: number): Position | null {
  const a = points[edgeIndex];
  const b = points[(edgeIndex + 1) % points.length];
  if (a === undefined || b === undefined) return null;
  return [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
}

/** Deletes point `index` unless 3 remain or the removal would make edges cross (UX F-04 step 6). */
export function deletePoint(
  state: EditState,
  index: number,
  limits: DrawingLimits = DEFAULT_DRAWING_LIMITS,
): EditState {
  if (state.points.length <= 3) return { ...state, refusal: 'min-points' };
  const points = state.points.filter((_, i) => i !== index);
  if (ringProblem(points, limits) !== null) return { ...state, refusal: 'delete-would-cross' };
  return commit(state, points, null);
}

export function undoEdit(state: EditState): EditState {
  const previous = state.undoStack.at(-1);
  if (previous === undefined) return state;
  return {
    ...state,
    points: previous,
    undoStack: state.undoStack.slice(0, -1),
    selected: null,
    refusal: null,
  };
}

export function selectPoint(state: EditState, index: number | null): EditState {
  if (index !== null && (index < 0 || index >= state.points.length)) return state;
  return { ...state, selected: index, moveArmed: false, refusal: null };
}

/** `]` / `[` cycle through points (UX C-12 keyboard). */
export function cycleSelection(state: EditState, direction: 1 | -1): EditState {
  const count = state.points.length;
  if (count === 0) return state;
  const next =
    state.selected === null
      ? direction === 1
        ? 0
        : count - 1
      : (state.selected + direction + count) % count;
  return selectPoint(state, next);
}

function samePosition(a: Position | undefined, b: Position): boolean {
  if (a === undefined) return false;
  return a[0] === b[0] && a[1] === b[1];
}

export function isDirty(state: EditState): boolean {
  return (
    state.points.length !== state.original.length ||
    state.points.some((point, i) => !samePosition(state.original[i], point))
  );
}

export function editMetrics(points: readonly Position[]): { areaKm2: number; perimeterKm: number } {
  return { areaKm2: geodesicArea([points]), perimeterKm: geodesicPerimeter([closeRing(points)]) };
}
