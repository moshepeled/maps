import type { Position } from '@snapland/shared';
import { geodesicArea, geodesicPerimeter, quantizeRing } from '@snapland/shared';
import { describe, expect, it } from 'vitest';

import fixtures from '../../../docs/fixtures/geodesic-area-fixtures.json';
import type { DrawingState } from './drawingReducer';
import {
  EMPTY_DRAWING,
  addPoint,
  canUndo,
  deriveDrawing,
  drawingKeyAction,
  finish,
  finishProblem,
  restoreDrawing,
  setPointer,
  undoPoint,
} from './drawingReducer';

interface FixturePolygon {
  name: string;
  geojson: { coordinates: number[][][] };
  area_km2_spheroid?: number;
}

function fixture(name: string, list: readonly FixturePolygon[] = fixtures.polygons): FixturePolygon {
  const found = list.find((candidate) => candidate.name === name);
  if (found === undefined) throw new Error(`missing fixture ${name}`);
  return found;
}

/** The exterior ring without its closing position, as the user would click it. */
function clickedPoints(polygon: FixturePolygon): Position[] {
  const ring = polygon.geojson.coordinates[0] ?? [];
  return ring
    .slice(0, -1)
    .map((position): Position => [position[0] ?? Number.NaN, position[1] ?? Number.NaN]);
}

function place(points: readonly Position[], state: DrawingState = EMPTY_DRAWING): DrawingState {
  return points.reduce<DrawingState>((current, point) => addPoint(current, point).state, state);
}

function relative(a: number, b: number): number {
  return Math.abs(a - b) / Math.abs(b);
}

describe('drawingReducer - fixture readouts (SPEC section 8.5 unit proof)', () => {
  it.each(['tel_aviv_1km_square', 'field_1_hectare', 'circle_50_vertices'])(
    'readout of %s is within 1e-6 of the PostGIS spheroid area',
    (name) => {
      const polygon = fixture(name);
      const state = place(clickedPoints(polygon));
      const view = deriveDrawing(state);
      expect(view.areaKm2).not.toBeNull();
      expect(relative(view.areaKm2 ?? 0, polygon.area_km2_spheroid ?? Number.NaN)).toBeLessThanOrEqual(1e-6);
      expect(view.canFinish).toBe(true);
      const finished = finish(state);
      expect(finished.ok).toBe(true);
    },
  );

  it('the readout equals geodesicArea(quantize7(points + provisional)) and includes the pointer only when simple', () => {
    const square = clickedPoints(fixture('tel_aviv_1km_square'));
    const three = place(square.slice(0, 3));
    const pointer: Position = square[3] ?? [0, 0];
    const withPointer = setPointer(three, [pointer[0] + 0.00000004, pointer[1]]);
    const view = deriveDrawing(withPointer);
    expect(view.provisional).not.toBeNull();
    const expected = geodesicArea([quantizeRing([...withPointer.points, view.provisional ?? [0, 0]], 7)]);
    expect(relative(view.areaKm2 ?? 0, expected)).toBeLessThanOrEqual(1e-9);
    expect(view.perimeterKm).toBeCloseTo(
      geodesicPerimeter([[...withPointer.points, view.provisional ?? [0, 0]]]),
      9,
    );
    // A pointer whose closing edge would cross: the readout falls back to the placed ring.
    const crossing = setPointer(place(square), [34.785, 32.07]);
    expect(deriveDrawing(crossing).provisional).toBeNull();
  });

  it('a bowtie point is refused with data-code crossing (UX-AC-15 rule)', () => {
    const bowtie = clickedPoints(fixture('bowtie_self_intersection', fixtures.invalid_polygons));
    let state = place(bowtie.slice(0, 3));
    expect(state.points).toHaveLength(3);
    const result = addPoint(state, bowtie[3] ?? [0, 0]);
    expect(result.outcome).toBe('refused');
    if (result.outcome === 'refused') expect(result.code).toBe('crossing');
    state = result.state;
    expect(state.points).toHaveLength(3);
    const view = deriveDrawing(state);
    expect(view.message.code).toBe('crossing');
    expect(view.invalid?.marker).not.toBeNull();
    expect(view.invalid?.edges).toHaveLength(2);
    expect(view.hudState).toBe('invalid');
  });

  it('a point doubling back over the last edge is refused as a spike', () => {
    const state = place([
      [34.78, 32.08],
      [34.79, 32.08],
    ]);
    const result = addPoint(state, [34.785, 32.08]);
    expect(result.outcome).toBe('refused');
    if (result.outcome === 'refused') expect(result.code).toBe('spike');
  });
});

describe('UX-AC-17 undo while drawing', () => {
  it('UX-AC-17 Backspace, Ctrl+Z and the undo button each remove exactly one point and update the readout', () => {
    const square = clickedPoints(fixture('tel_aviv_1km_square'));
    const four = place(square);
    const before = deriveDrawing(four).areaKm2;
    const three = undoPoint(four);
    expect(three.points).toHaveLength(3);
    expect(deriveDrawing(three).areaKm2).not.toBe(before);
    expect(undoPoint(three).points).toHaveLength(2);
    expect(deriveDrawing(undoPoint(three)).areaKm2).toBeNull();

    const key = (
      key: string,
      extra: Partial<{ ctrlKey: boolean; metaKey: boolean; shiftKey: boolean }> = {},
    ) => drawingKeyAction({ key, ctrlKey: false, metaKey: false, shiftKey: false, ...extra });
    expect(key('Backspace')).toBe('undo');
    expect(key('z', { ctrlKey: true })).toBe('undo');
    expect(key('Z', { metaKey: true })).toBe('undo');
    expect(key('z', { ctrlKey: true, shiftKey: true })).toBeNull();
    expect(key('Enter')).toBe('finish');
    expect(key(' ')).toBe('place');
    expect(key('Escape')).toBe('cancel');
    expect(key('d')).toBeNull();
  });

  it('UX-AC-17 at 0 points undo is disabled and a no-op', () => {
    expect(canUndo(EMPTY_DRAWING)).toBe(false);
    expect(undoPoint(EMPTY_DRAWING)).toBe(EMPTY_DRAWING);
    expect(canUndo(place([[34.78, 32.08]]))).toBe(true);
  });
});

describe('UX-AC-19 shapes that cannot be finished', () => {
  it('UX-AC-19 larger than MAX_AREA_KM2 -> too-large, finish refused', () => {
    const huge = place([
      [0, 0],
      [15, 0],
      [15, 15],
      [0, 15],
    ]);
    const view = deriveDrawing(huge);
    expect(view.message.code).toBe('too-large');
    expect(view.canFinish).toBe(false);
    const result = finish(huge);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('too-large');
  });

  it('UX-AC-19 collinear points -> zero-area, finish refused', () => {
    const collinear = place([
      [34.78, 32.08],
      [34.79, 32.08],
      [34.8, 32.08],
    ]);
    const result = finish(collinear);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('zero-area');
      expect(deriveDrawing(result.state).message.code).toBe('zero-area');
    }
  });

  it('UX-AC-19 wider than 20° -> extent-too-large, finish refused', () => {
    const wide = place([
      [0, 0],
      [25, 0],
      [25, 1],
    ]);
    expect(deriveDrawing(wide).message.code).toBe('extent-too-large');
    expect(finishProblem(wide.points)).toBe('extent-too-large');
    const result = finish(wide);
    expect(result.ok).toBe(false);
  });

  it('fewer than 3 points -> need-more', () => {
    const two = place([
      [34.78, 32.08],
      [34.79, 32.08],
    ]);
    expect(finishProblem(two.points)).toBe('need-more');
    expect(deriveDrawing(two).hudState).toBe('need-more');
    expect(deriveDrawing(EMPTY_DRAWING).hudState).toBe('empty');
  });
});

describe('placement rules', () => {
  it('ignores an exact duplicate of the last point', () => {
    const one = place([[34.78, 32.08]]);
    expect(addPoint(one, [34.78, 32.08]).outcome).toBe('ignored');
  });

  it('refuses a latitude beyond the Web-Mercator limit', () => {
    const result = addPoint(EMPTY_DRAWING, [10, 86]);
    expect(result.outcome).toBe('refused');
    if (result.outcome === 'refused') expect(result.code).toBe('out-of-range');
  });

  it('unwraps continuous longitudes and refuses a shape crossing the antimeridian', () => {
    const first = addPoint(EMPTY_DRAWING, [179.5 + 360, 0]).state;
    expect(first.points[0]?.[0]).toBeCloseTo(179.5, 9);
    const crossing = addPoint(first, [-179.5, 0]);
    expect(crossing.outcome).toBe('refused');
    if (crossing.outcome === 'refused') expect(crossing.code).toBe('antimeridian');
  });

  it('refuses points beyond the configured point limit', () => {
    const limits = { maxPoints: 3, maxAreaKm2: 100_000, minAreaKm2: 0.000001, maxExtentDeg: 20 };
    let state = EMPTY_DRAWING;
    for (const point of [
      [34.78, 32.08],
      [34.79, 32.08],
      [34.79, 32.09],
    ] as Position[]) {
      state = addPoint(state, point, limits).state;
    }
    const result = addPoint(state, [34.78, 32.09], limits);
    expect(result.outcome).toBe('refused');
    if (result.outcome === 'refused') expect(result.code).toBe('max-points');
  });

  it('restoreDrawing quantises to 7 dp and clears transient state', () => {
    const restored = restoreDrawing([[34.781234567, 32.08]]);
    expect(restored.points[0]?.[0]).toBe(34.7812346);
    expect(restored.pointer).toBeNull();
  });

  it('the closing edge crossing blocks finish with closing-crosses', () => {
    const zigzag = place([
      [34.78, 32.08],
      [34.8, 32.08],
      [34.78, 32.09],
      [34.8, 32.09],
    ]);
    expect(zigzag.points).toHaveLength(4);
    const view = deriveDrawing(zigzag);
    expect(view.message.code).toBe('closing-crosses');
    expect(view.areaKm2).toBeNull();
    const result = finish(zigzag);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('closing-crosses');
  });
});

describe('a pointer resting on a placed point is no provisional point (C-06.3)', () => {
  const triangle: Position[] = [
    [34.78, 32.08],
    [34.79, 32.08],
    [34.785, 32.09],
  ];

  it('the pointer on the point just placed keeps the shape valid with the finish hint', () => {
    // A click (or tap, or Space at the reticle) leaves the pointer exactly where the point was placed.
    const state = setPointer(place(triangle), triangle[2] ?? [0, 0]);
    const view = deriveDrawing(state);
    expect(view.hudState).toBe('valid');
    expect(view.message.code).toBe('hint');
    expect(view.invalid).toBeNull();
    expect(view.provisional).toBeNull();
    expect(view.pointer).toBeNull();
    expect(view.areaKm2).toBe(deriveDrawing(place(triangle)).areaKm2);
  });

  it('the pointer that set a point before it was placed changes nothing either (desktop click without a move)', () => {
    const hovered = setPointer(place(triangle.slice(0, 2)), triangle[2] ?? [0, 0]);
    const placed = addPoint(hovered, triangle[2] ?? [0, 0]);
    expect(placed.outcome).toBe('added');
    const view = deriveDrawing(placed.state);
    expect(view.hudState).toBe('valid');
    expect(view.message.code).toBe('hint');
  });

  it('the pointer on the first point (snap to finish) previews the placed ring, closed', () => {
    const view = deriveDrawing(setPointer(place(triangle), triangle[0] ?? [0, 0]));
    expect(view.hudState).toBe('valid');
    expect(view.message.code).toBe('hint');
    expect(view.pointer).toBeNull();
  });

  it('anywhere else the pointer is still the provisional point', () => {
    const view = deriveDrawing(setPointer(place(triangle), [34.782, 32.092]));
    expect(view.pointer).toEqual([34.782, 32.092]);
    expect(view.provisional).toEqual([34.782, 32.092]);
    expect(view.pointerPlaceable).toBe(true);
  });
});
