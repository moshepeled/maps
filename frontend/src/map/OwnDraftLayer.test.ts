/**
 * My draft on the map (UX C-06, UI.md section 9.5): which paths and glyphs each stage draws. Colours and widths come from
 * map.css by class, so the classes are what is asserted here.
 */
import type { Position } from '@snapland/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { MapInstance } from './mapInstance';
import { createMapInstance } from './mapInstance';
import type { OwnDraftInput } from './OwnDraftLayer';
import { OwnDraftLayer, pointKind } from './OwnDraftLayer';

const POINTS: Position[] = [
  [34.78, 32.08],
  [34.79, 32.08],
  [34.79, 32.09],
];

let instance: MapInstance;
let layer: OwnDraftLayer;

beforeEach(() => {
  const host = document.createElement('div');
  document.body.append(host);
  instance = createMapInstance(host, 'mercator', [32.085, 34.785], 15);
  layer = new OwnDraftLayer(instance.map);
});

afterEach(() => {
  layer.dispose();
  instance.dispose();
  document.body.replaceChildren();
});

function input(overrides: Partial<OwnDraftInput> = {}): OwnDraftInput {
  return {
    stage: 'drawing',
    points: POINTS,
    provisional: null,
    pointer: null,
    invalid: null,
    serverMarker: null,
    firstPointHot: false,
    ...overrides,
  };
}

const all = (selector: string) => [...instance.container.querySelectorAll(selector)];
const one = (selector: string) => instance.container.querySelector(selector);

describe('pointKind', () => {
  it('marks the first and last point while drawing, and only small dots once finished', () => {
    expect([0, 1, 2].map((index) => pointKind('drawing', index, 3))).toEqual(['first', 'placed', 'last']);
    expect(pointKind('drawing', 0, 1)).toBe('first');
    expect(pointKind('finished', 0, 3)).toBe('unsaved');
    expect(pointKind('saving', 2, 3)).toBe('unsaved');
  });
});

describe('OwnDraftLayer', () => {
  it('with a pointer: solid placed edges, a cased dashed rubber-band and an uncased closing preview', () => {
    const pointer: Position = [34.785, 32.095];
    layer.sync(input({ pointer, provisional: pointer }));
    const shape = one('[data-testid="own-draft"]');
    expect(shape?.getAttribute('data-points')).toBe('3');
    expect(shape?.getAttribute('data-state')).toBe('drawing');
    expect(shape?.getAttribute('class')).toContain('ov-fill ov-own');
    expect(all('path.ov-own.ov-core')).toHaveLength(1);
    expect(all('path.ov-own.ov-casing')).toHaveLength(1);
    expect(all('path.ov-rubber.ov-core')).toHaveLength(1);
    expect(all('path.ov-rubber.ov-casing')).toHaveLength(1);
    expect(all('path.ov-closing.ov-core')).toHaveLength(1);
    expect(all('path.ov-closing.ov-casing')).toHaveLength(0);
    expect(all('path.is-closed')).toHaveLength(0);
    expect(all('.snap-point--first')).toHaveLength(1);
    expect(all('.snap-point--placed')).toHaveLength(1);
    expect(all('.snap-point--last')).toHaveLength(1);
    expect(one('[data-testid="own-shape-chip"]')).toBeNull();
  });

  it('without a pointer (touch, or off the map): the placed points closed, the closing edge dotted on a casing', () => {
    layer.sync(input());
    expect(all('path.ov-rubber')).toHaveLength(0);
    expect(all('path.ov-closing.is-closed.ov-core')).toHaveLength(1);
    expect(all('path.ov-closing.is-closed.ov-casing')).toHaveLength(1);
  });

  it('keeps the point glyphs while only the pointer moves, and rebuilds them when the points change', () => {
    layer.sync(input({ pointer: [34.785, 32.095] }));
    const first = one('.snap-point--first');
    layer.sync(input({ pointer: [34.786, 32.096] }));
    expect(one('.snap-point--first')).toBe(first);
    layer.sync(input({ pointer: [34.786, 32.096], firstPointHot: true }));
    expect(one('.snap-point--first.is-hot')).not.toBeNull();
    layer.sync(input({ points: [...POINTS, [34.78, 32.09]] }));
    expect(all('.snap-point')).toHaveLength(4);
    expect(one('.snap-point--first')).not.toBe(first);
  });

  it('finished: a closed "me" shape with its fill, small unsaved dots and the "Unsaved" chip', () => {
    layer.sync(input({ stage: 'finished' }));
    const shape = one('[data-testid="own-draft"]');
    expect(shape?.getAttribute('class')).toContain('ov-core ov-fill ov-own');
    expect(shape?.getAttribute('data-state')).toBe('finished');
    expect(all('path.ov-closing')).toHaveLength(0);
    expect(all('.snap-point--unsaved')).toHaveLength(3);
    const chip = one('[data-testid="own-shape-chip"]');
    expect(chip?.getAttribute('data-state')).toBe('unsaved');
    expect(chip?.querySelector('.spinner')).toBeNull();
  });

  it('saving: the core dims (is-saving) and the chip gets a spinner', () => {
    layer.sync(input({ stage: 'saving' }));
    expect(one('[data-testid="own-draft"]')?.classList.contains('is-saving')).toBe(true);
    const chip = one('[data-testid="own-shape-chip"]');
    expect(chip?.getAttribute('data-state')).toBe('saving');
    expect(chip?.querySelector('.spinner')).not.toBeNull();
  });

  it('invalid: colour AND pattern on each edge, with its outline, a x tick per edge and the marker', () => {
    const crossing: Position = [34.785, 32.085];
    layer.sync(
      input({
        pointer: [34.79, 32.07],
        invalid: {
          edges: [
            [
              [34.78, 32.08],
              [34.79, 32.09],
            ],
            [
              [34.79, 32.08],
              [34.78, 32.09],
            ],
          ],
          marker: crossing,
        },
      }),
    );
    const edges = all('[data-testid="invalid-edge"]');
    expect(edges).toHaveLength(2);
    for (const edge of edges) expect(edge.getAttribute('class')).toContain('ov-core ov-invalid');
    // The rubber-band itself also turns invalid (the pointer is not placeable).
    expect(all('path.ov-outline.ov-invalid')).toHaveLength(3);
    expect(all('.snap-invalid-tick')).toHaveLength(2);
    expect(all('[data-testid="invalid-marker"]')).toHaveLength(1);
  });

  it('hidden: draws nothing', () => {
    layer.sync(input());
    layer.sync(input({ stage: 'hidden' }));
    expect(all('path')).toHaveLength(0);
    expect(all('.snap-point')).toHaveLength(0);
  });
});
