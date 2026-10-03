/**
 * The drawing tool's pure state machine (UX F-03, C-06; SPEC section 8.5, section 8.6). Geometry lives here as WGS84 lat/lng - * never pixels - so it survives base-layer switches and map rebuilds untouched (SPEC section 8.4). Every placed and
 * provisional point is quantised to 7 dp at entry, which makes the live readout equal to the server's stored value
 * (`geodesicArea(quantize7(points + provisional))`, <= 1e-9 relative).
 */
import type { GeometryErrorCode, Position } from '@snapland/shared';
import {
  COMMITTED_DECIMALS,
  LIMITS,
  geodesicArea,
  geodesicPerimeter,
  quantizePosition,
  validatePolygon,
} from '@snapland/shared';

import type { EdgeIssue } from '../lib/drawGeometry';
import {
  closingEdgeIssue,
  newPointIssue,
  provisionalRingIssue,
  unwrapLongitude,
  withinLongitudeRange,
  wrapLongitude,
} from '../lib/drawGeometry';

/** `hud-message[data-code]` values (UX section 12). */
export type HudCode =
  | 'crossing'
  | 'spike'
  | 'closing-crosses'
  | 'need-more'
  | 'zero-area'
  | 'too-large'
  | 'extent-too-large'
  | 'antimeridian'
  | 'out-of-range'
  | 'max-points'
  | 'rate-limited'
  | 'sharing-paused'
  | 'newer-version'
  | 'other-editing'
  | 'lock-both'
  | 'lock-race'
  | 'lock-unknown'
  | 'server-invalid'
  | 'hint';

export type HudSeverity = 'error' | 'warning' | 'hint';

export interface DrawingLimits {
  /** Points of a drawn single-ring shape (`maxPositions − 1`). */
  maxPoints: number;
  maxAreaKm2: number;
  minAreaKm2: number;
  maxExtentDeg: number;
}

export const DEFAULT_DRAWING_LIMITS: DrawingLimits = {
  maxPoints: LIMITS.maxPositionsTotal - 1,
  maxAreaKm2: LIMITS.maxAreaKm2,
  minAreaKm2: LIMITS.minAreaKm2,
  maxExtentDeg: LIMITS.maxExtentDeg,
};

/** A refused placement or finish: its reason stays in the HUD until the next successful change. */
export interface Refusal {
  code: HudCode;
  kind: 'place' | 'finish';
  issue: EdgeIssue | null;
}

export interface DrawingState {
  /** Placed points, 7 dp, longitudes unwrapped relative to the first point. */
  points: Position[];
  /** The pointer / crosshair position (7 dp), or null when it is off the map or on touch. */
  pointer: Position | null;
  refusal: Refusal | null;
}

export const EMPTY_DRAWING: DrawingState = { points: [], pointer: null, refusal: null };

export type AddPointResult =
  | { outcome: 'added'; state: DrawingState }
  | { outcome: 'refused' | 'ignored'; state: DrawingState; code: HudCode | null };

export type FinishResult =
  | { ok: true; state: DrawingState; ring: Position[]; areaKm2: number }
  | { ok: false; state: DrawingState; code: HudCode };

function quantize7(position: Position): Position {
  return quantizePosition(position, COMMITTED_DECIMALS);
}

/** Brings a raw Leaflet lat/lng into the drawing's longitude frame (SPEC section 9.2 antimeridian policy). */
function normalizeCandidate(points: readonly Position[], candidate: Position): Position {
  const last = points.at(-1);
  const lng = last === undefined ? wrapLongitude(candidate[0]) : unwrapLongitude(last[0], candidate[0]);
  return quantize7([lng, candidate[1]]);
}

function samePosition(a: Position, b: Position): boolean {
  return a[0] === b[0] && a[1] === b[1];
}

function codeForEdgeIssue(issue: EdgeIssue): HudCode {
  return issue.kind === 'fold' ? 'spike' : 'crossing';
}

/** Why a point could not be placed at `candidate` (already normalised), or null. */
function placementProblem(
  points: readonly Position[],
  candidate: Position,
  limits: DrawingLimits,
): { code: HudCode; issue: EdgeIssue | null } | null {
  if (Math.abs(candidate[1]) > LIMITS.maxLatitude) return { code: 'out-of-range', issue: null };
  if (!withinLongitudeRange([...points, candidate])) return { code: 'antimeridian', issue: null };
  if (points.length >= limits.maxPoints) return { code: 'max-points', issue: null };
  const issue = newPointIssue(points, candidate);
  return issue === null ? null : { code: codeForEdgeIssue(issue), issue };
}

/** Adds a point (UX C-06.2, C-06.5): refused when it would cross, fold back, leave the map or exceed the limit. */
export function addPoint(
  state: DrawingState,
  raw: Position,
  limits: DrawingLimits = DEFAULT_DRAWING_LIMITS,
): AddPointResult {
  const candidate = normalizeCandidate(state.points, raw);
  const last = state.points.at(-1);
  if (last !== undefined && samePosition(last, candidate)) {
    return { outcome: 'ignored', state, code: null };
  }
  const problem = placementProblem(state.points, candidate, limits);
  if (problem !== null) {
    return {
      outcome: 'refused',
      code: problem.code,
      state: { ...state, refusal: { code: problem.code, kind: 'place', issue: problem.issue } },
    };
  }
  return { outcome: 'added', state: { ...state, points: [...state.points, candidate], refusal: null } };
}

/** Removes exactly the last point (UX C-06.7); a no-op at 0 points. */
export function undoPoint(state: DrawingState): DrawingState {
  if (state.points.length === 0) return state;
  return { ...state, points: state.points.slice(0, -1), refusal: null };
}

export function canUndo(state: DrawingState): boolean {
  return state.points.length > 0;
}

/** Records the pointer (or crosshair) position; null hides the rubber-band and provisional point. */
export function setPointer(state: DrawingState, raw: Position | null): DrawingState {
  const pointer = raw === null ? null : normalizeCandidate(state.points, raw);
  if (
    pointer === state.pointer ||
    (pointer !== null && state.pointer !== null && samePosition(pointer, state.pointer))
  ) {
    return state;
  }
  // A new pointer position replaces a stale placement refusal (the pointer-derived message takes over).
  const refusal = state.refusal?.kind === 'place' ? null : state.refusal;
  return { ...state, pointer, refusal };
}

export function clearRefusal(state: DrawingState): DrawingState {
  return state.refusal === null ? state : { ...state, refusal: null };
}

/** Restores a drawing (Undo after Cancel, the restore banner, session resume). */
export function restoreDrawing(points: readonly Position[]): DrawingState {
  return { points: points.map((point) => quantize7(point)), pointer: null, refusal: null };
}

function closed(points: readonly Position[]): Position[] {
  const first = points[0];
  return first === undefined ? [] : [...points, first];
}

const VALIDATOR_CODE_TO_HUD: Partial<Record<GeometryErrorCode, HudCode>> = {
  SELF_INTERSECTION: 'closing-crosses',
  TOO_FEW_POSITIONS: 'need-more',
  AREA_TOO_SMALL: 'zero-area',
  AREA_TOO_LARGE: 'too-large',
  EXTENT_TOO_LARGE: 'extent-too-large',
  ANTIMERIDIAN_CROSSING: 'antimeridian',
  COORDINATE_OUT_OF_RANGE: 'out-of-range',
  TOO_MANY_VERTICES: 'max-points',
};

/**
 * Validates the closed shape with the shared validator (the same code the server runs, SPEC section 9.2) plus the runtime
 * limits from `/config`. Returns the HUD code of the first problem, or null when the shape can be finished.
 */
export function finishProblem(
  points: readonly Position[],
  limits: DrawingLimits = DEFAULT_DRAWING_LIMITS,
): HudCode | null {
  if (points.length < 3) return 'need-more';
  const result = validatePolygon({ type: 'Polygon', coordinates: [closed(points)] });
  if (!result.ok) {
    const code = result.issues[0]?.code;
    return (code === undefined ? undefined : VALIDATOR_CODE_TO_HUD[code]) ?? 'closing-crosses';
  }
  if (result.areaKm2 > limits.maxAreaKm2) return 'too-large';
  if (result.areaKm2 < limits.minAreaKm2) return 'zero-area';
  return null;
}

/** Finish (any of the four methods, UX C-06.6): the closed ring on success, the refusal reason otherwise. */
export function finish(state: DrawingState, limits: DrawingLimits = DEFAULT_DRAWING_LIMITS): FinishResult {
  const problem = finishProblem(state.points, limits);
  if (problem !== null) {
    const issue = problem === 'closing-crosses' ? closingEdgeIssue(state.points) : null;
    return {
      ok: false,
      code: problem,
      state: { ...state, refusal: { code: problem, kind: 'finish', issue } },
    };
  }
  const ring = closed(state.points);
  return { ok: true, ring, areaKm2: geodesicArea([ring]), state: { ...state, pointer: null, refusal: null } };
}

// -- Derived view (readout, HUD message, invalid overlay) -------------------------------------

export interface HudMessage {
  code: HudCode;
  severity: HudSeverity;
}

export interface DrawingView {
  /** The raw readout (`area-readout[data-km2]`), or null for "Area - ". */
  areaKm2: number | null;
  perimeterKm: number | null;
  /** The provisional point the readout includes (7 dp), or null. */
  provisional: Position | null;
  /** Where the rubber-band ends: the pointer, or null while it rests on a placed point (`restingPointer`). */
  pointer: Position | null;
  /** `draw-hud[data-state]`. */
  hudState: 'empty' | 'need-more' | 'valid' | 'invalid';
  message: HudMessage;
  /** Edges and marker to draw in the invalid style (UX-AC-15). */
  invalid: { edges: [Position, Position][]; marker: Position | null } | null;
  canFinish: boolean;
  finishBlocker: HudCode | null;
  /** Whether a point may be placed at the pointer (drives the `not-allowed` cursor). */
  pointerPlaceable: boolean;
}

const ERROR_CODES: ReadonlySet<HudCode> = new Set<HudCode>([
  'crossing',
  'spike',
  'closing-crosses',
  'zero-area',
  'extent-too-large',
  'antimeridian',
  'out-of-range',
  'max-points',
  'server-invalid',
]);

export function severityOf(code: HudCode): HudSeverity {
  if (ERROR_CODES.has(code)) return 'error';
  if (code === 'hint' || code === 'need-more' || code === 'rate-limited' || code === 'sharing-paused')
    return 'hint';
  return 'warning';
}

function readout(ring: readonly Position[]): { areaKm2: number; perimeterKm: number } {
  return { areaKm2: geodesicArea([ring]), perimeterKm: geodesicPerimeter([closed(ring)]) };
}

function extentExceeded(points: readonly Position[], limits: DrawingLimits): boolean {
  if (points.length < 2) return false;
  const lngs = points.map(([lng]) => lng);
  const lats = points.map(([, lat]) => lat);
  return (
    Math.max(...lngs) - Math.min(...lngs) > limits.maxExtentDeg ||
    Math.max(...lats) - Math.min(...lats) > limits.maxExtentDeg
  );
}

interface ReadoutChoice {
  ring: Position[] | null;
  provisional: Position | null;
  pointerIssue: { code: HudCode; issue: EdgeIssue | null } | null;
  closingIssue: EdgeIssue | null;
}

/**
 * The pointer as a provisional point, or null while it rests on the point just placed (every click, tap and Space
 * at the reticle leaves it there) or on the first point it would close the shape at. Such a ring repeats a vertex,
 * which the validator reports as a crossing although the shape is valid, so it counts as "no pointer" (C-06.3).
 */
function restingPointer(state: DrawingState): Position | null {
  const { points, pointer } = state;
  if (pointer === null) return null;
  const last = points.at(-1);
  const first = points[0];
  if (last !== undefined && samePosition(pointer, last)) return null;
  if (points.length >= 3 && first !== undefined && samePosition(pointer, first)) return null;
  return pointer;
}

/**
 * UX C-06.4 "what it measures": placed points + the pointer when it is placeable and that ring is simple; otherwise
 * the placed points alone when their ring is simple; otherwise nothing ("Area - ").
 */
function chooseReadoutRing(state: DrawingState, limits: DrawingLimits): ReadoutChoice {
  const { points } = state;
  const pointer = restingPointer(state);
  const pointerIssue = pointer === null ? null : placementProblem(points, pointer, limits);
  const placedClosingIssue = closingEdgeIssue(points);
  if (pointer !== null && pointerIssue === null && points.length >= 2) {
    const ringIssue = provisionalRingIssue(points, pointer);
    if (ringIssue === null)
      return { ring: [...points, pointer], provisional: pointer, pointerIssue, closingIssue: null };
    // The pointer is placeable but the closing preview crosses: fall back to the placed ring.
    return {
      ring: points.length >= 3 && placedClosingIssue === null ? [...points] : null,
      provisional: null,
      pointerIssue,
      closingIssue: ringIssue,
    };
  }
  return {
    ring: points.length >= 3 && placedClosingIssue === null ? [...points] : null,
    provisional: null,
    pointerIssue,
    closingIssue: placedClosingIssue,
  };
}

function hintMessage(points: readonly Position[]): HudMessage {
  return points.length < 3 && points.length > 0
    ? { code: 'need-more', severity: 'hint' }
    : { code: 'hint', severity: 'hint' };
}

/** Everything the HUD, readout and invalid overlay render, derived purely from the state. */
export function deriveDrawing(
  state: DrawingState,
  limits: DrawingLimits = DEFAULT_DRAWING_LIMITS,
): DrawingView {
  const choice = chooseReadoutRing(state, limits);
  const measured = choice.ring !== null && choice.ring.length >= 3 ? readout(choice.ring) : null;
  const finishBlocker = finishProblem(state.points, limits);
  const extentPoints = choice.provisional === null ? state.points : [...state.points, choice.provisional];

  let message: HudMessage = hintMessage(state.points);
  let invalid: DrawingView['invalid'] = null;
  const refusalIssue = state.refusal?.issue ?? null;
  if (state.refusal !== null) {
    message = { code: state.refusal.code, severity: severityOf(state.refusal.code) };
    if (refusalIssue !== null)
      invalid = { edges: [refusalIssue.edge, refusalIssue.other], marker: refusalIssue.location };
  } else if (choice.pointerIssue !== null && choice.pointerIssue.code !== 'max-points') {
    message = { code: choice.pointerIssue.code, severity: 'error' };
    const issue = choice.pointerIssue.issue;
    if (issue !== null) invalid = { edges: [issue.edge, issue.other], marker: issue.location };
  } else if (choice.closingIssue !== null) {
    message = { code: 'closing-crosses', severity: 'error' };
    invalid = {
      edges: [choice.closingIssue.edge, choice.closingIssue.other],
      marker: choice.closingIssue.location,
    };
  } else if (extentExceeded(extentPoints, limits)) {
    message = { code: 'extent-too-large', severity: 'error' };
  } else if (measured !== null && measured.areaKm2 > limits.maxAreaKm2) {
    message = { code: 'too-large', severity: 'warning' };
  }

  const pointer = restingPointer(state);
  const hudState: DrawingView['hudState'] =
    state.points.length === 0
      ? 'empty'
      : message.severity === 'error'
        ? 'invalid'
        : state.points.length < 3
          ? 'need-more'
          : 'valid';

  return {
    areaKm2: measured?.areaKm2 ?? null,
    perimeterKm: measured?.perimeterKm ?? null,
    provisional: choice.provisional,
    pointer,
    hudState,
    message,
    invalid,
    canFinish: finishBlocker === null,
    finishBlocker,
    pointerPlaceable: pointer !== null && choice.pointerIssue === null,
  };
}

// -- Keyboard mapping (UX section 8.1, C-06.7, C-06.9) ----------------------------------------------

export type DrawingKeyAction = 'undo' | 'finish' | 'place' | 'cancel' | null;

export interface KeyLike {
  key: string;
  ctrlKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
}

/** Keys the map container handles in Drawing: Backspace / Ctrl+Z undo, Enter finish, Space place, Esc cancel. */
export function drawingKeyAction(event: KeyLike): DrawingKeyAction {
  const modifier = event.ctrlKey || event.metaKey;
  if (event.key === 'Backspace' && !modifier) return 'undo';
  if (modifier && !event.shiftKey && (event.key === 'z' || event.key === 'Z')) return 'undo';
  if (event.key === 'Enter' && !modifier) return 'finish';
  if (event.key === ' ' && !modifier) return 'place';
  if (event.key === 'Escape') return 'cancel';
  return null;
}
