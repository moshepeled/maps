/**
 * Shape editing (UI.md section 9.6): my shape on its casing keeps its SVG paths through a drag, and an invalid drag or a
 * save only toggles their state classes; the selected handle shows the armed *Move point* halo.
 */
import type { Position } from '@snapland/shared';
import L from 'leaflet';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { MapInstance } from './mapInstance';
import { createMapInstance } from './mapInstance';
import type { VertexEditorInput } from './VertexEditor';
import { VertexEditor } from './VertexEditor';

const POINTS: Position[] = [
  [34.78, 32.08],
  [34.79, 32.08],
  [34.79, 32.09],
  [34.78, 32.09],
];

let instance: MapInstance;
let editor: VertexEditor;

beforeEach(() => {
  const host = document.createElement('div');
  document.body.append(host);
  instance = createMapInstance(host, 'mercator', [32.085, 34.785], 15);
  const noop = (): void => undefined;
  editor = new VertexEditor(instance.map, {
    onSelect: noop,
    onDragStart: noop,
    onDrag: noop,
    onDragEnd: noop,
    onMidpointActivate: noop,
    onDeleteRequest: noop,
  });
});

afterEach(() => {
  editor.dispose();
  instance.dispose();
  document.body.replaceChildren();
});

function input(overrides: Partial<VertexEditorInput> = {}): VertexEditorInput {
  return {
    points: POINTS,
    selected: null,
    moveArmed: false,
    dragging: null,
    saving: false,
    coarse: false,
    ...overrides,
  };
}

const all = (selector: string) => [...instance.container.querySelectorAll(selector)];
const one = (selector: string) => instance.container.querySelector(selector);

/** The midpoint handle marker of edge `edge` (edge i runs from point i to point i + 1). */
function midpointMarker(edge: number): L.Marker | undefined {
  let found: L.Marker | undefined;
  instance.map.eachLayer((layer) => {
    const selector = `[data-testid="midpoint-handle"][data-index="${edge}"]`;
    if (layer instanceof L.Marker && layer.getElement()?.querySelector(selector)) found = layer;
  });
  return found;
}

function positionOf(marker: L.Marker | undefined): Position | undefined {
  const latLng = marker?.getLatLng();
  return latLng === undefined ? undefined : [latLng.lng, latLng.lat];
}

describe('VertexEditor', () => {
  it('draws my shape as outline, casing and a filled "me" core, with a handle per point', () => {
    editor.sync(input());
    const core = one('[data-testid="own-draft"]');
    expect(core?.getAttribute('class')).toContain('ov-core ov-fill ov-own ov-edit');
    expect(core?.getAttribute('data-state')).toBe('editing');
    expect(all('path.ov-edit.ov-casing')).toHaveLength(1);
    expect(all('path.ov-edit.ov-outline')).toHaveLength(1);
    expect(all('[data-testid="point-handle"]')).toHaveLength(4);
  });

  it('an invalid drag toggles is-invalid on the same paths (the drag is never interrupted)', () => {
    editor.sync(input());
    const core = one('[data-testid="own-draft"]');
    editor.sync(input({ dragging: { index: 0, position: [34.795, 32.095], invalid: true } }));
    expect(one('[data-testid="own-draft"]')).toBe(core);
    expect(all('path.ov-edit.is-invalid')).toHaveLength(3);
    editor.sync(input({ dragging: { index: 0, position: [34.781, 32.081], invalid: false } }));
    expect(all('path.ov-edit.is-invalid')).toHaveLength(0);
  });

  it('saving dims the core and removes the handles', () => {
    editor.sync(input({ saving: true }));
    expect(one('[data-testid="own-draft"]')?.classList.contains('is-saving')).toBe(true);
    expect(all('[data-testid="point-handle"]')).toHaveLength(0);
  });

  it('marks the selected handle armed while *Move point* is armed', () => {
    editor.sync(input({ selected: 1, moveArmed: true }));
    const armed = all('.snap-handle.is-armed');
    expect(armed).toHaveLength(1);
    expect(armed[0]?.getAttribute('data-index')).toBe('1');
    editor.sync(input({ selected: 1, moveArmed: false }));
    expect(all('.snap-handle.is-armed')).toHaveLength(0);
  });

  it("slides the midpoints of the dragged point's two edges live, without rebuilding any handle", () => {
    editor.sync(input());
    const before = [0, 1, 2, 3].map(midpointMarker);
    expect(before.every((marker) => marker !== undefined)).toBe(true);

    editor.sync(input({ dragging: { index: 0, position: [34.77, 32.07], invalid: false } }));

    // Same marker objects: Leaflet's drag gesture is never interrupted.
    expect([0, 1, 2, 3].map(midpointMarker)).toEqual(before);
    // Edge 0 (point 0 -> 1) and edge 3 (point 3 -> 0) follow the dragged point.
    expect(positionOf(before[0])?.[0]).toBeCloseTo(34.78, 9);
    expect(positionOf(before[0])?.[1]).toBeCloseTo(32.075, 9);
    expect(positionOf(before[3])?.[0]).toBeCloseTo(34.775, 9);
    expect(positionOf(before[3])?.[1]).toBeCloseTo(32.08, 9);
    // Edges that do not touch the dragged point stay where they were.
    expect(positionOf(before[1])?.[0]).toBeCloseTo(34.79, 9);
    expect(positionOf(before[1])?.[1]).toBeCloseTo(32.085, 9);
  });
});
