/**
 * Overlay helpers (UI.md section 9): the core + casing recipe, chips, bracket and tick geometry, and the token read-out the
 * canvas depends on (the map tone switches those tokens; the canvas cannot read CSS itself).
 */
import L from 'leaflet';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { MapInstance } from './mapInstance';
import { createMapInstance } from './mapInstance';
import { bracketLines, casedPath, chipElement, invalidTickPositions, readOverlayTokens } from './overlayUtil';

function style(values: Record<string, string>) {
  return { getPropertyValue: (name: string) => values[name] ?? '' };
}

describe('readOverlayTokens', () => {
  it('reads the canvas and bracket tokens of the current map tone (light OSM here)', () => {
    expect(
      readOverlayTokens(
        style({
          '--ov-area-stroke': ' #2f3a4a',
          '--ov-area-stroke-width': '1.75px',
          '--ov-area-fill': '#2f3a4a',
          '--ov-area-fill-opacity': '0.10',
          '--ov-bracket-size': '14px',
          '--ov-bracket-offset': '9px',
        }),
      ),
    ).toEqual({
      areaStroke: '#2f3a4a',
      areaStrokeWidth: 1.75,
      areaFill: '#2f3a4a',
      areaFillOpacity: 0.1,
      bracketSize: 14,
      bracketOffset: 9,
    });
  });

  it('falls back to the dark-tone values when the style is not loaded (UI.md section 14.4)', () => {
    expect(readOverlayTokens(style({}))).toEqual({
      areaStroke: '#eef1f5',
      areaStrokeWidth: 1.75,
      areaFill: '#ffffff',
      areaFillOpacity: 0.12,
      bracketSize: 14,
      bracketOffset: 9,
    });
  });
});

describe('casedPath (every overlay line is a core on a casing, UI.md section 9.2)', () => {
  let instance: MapInstance;
  let renderer: L.SVG;
  const ring: L.LatLngTuple[] = [
    [32.08, 34.78],
    [32.08, 34.79],
    [32.09, 34.79],
  ];

  beforeEach(() => {
    const host = document.createElement('div');
    document.body.append(host);
    instance = createMapInstance(host, 'mercator', [32.085, 34.785], 15);
    renderer = L.svg();
  });

  afterEach(() => {
    instance.dispose();
    document.body.replaceChildren();
  });

  function classesOf(path: { getElement(): Element | undefined }): string[] {
    return [...(path.getElement()?.classList ?? [])].filter(
      (name) => name.startsWith('ov-') || name.startsWith('is-'),
    );
  }

  it('draws the casing under the core, both non-interactive, with the role on each path', () => {
    const line = casedPath(ring, { renderer, role: 'ov-rubber', closed: false });
    for (const layer of line.layers) layer.addTo(instance.map);
    expect(line.layers).toHaveLength(2);
    expect(line.layers[1]).toBe(line.core);
    expect(classesOf(line.layers[0] as L.Path)).toEqual(['ov-casing', 'ov-rubber']);
    expect(classesOf(line.core)).toEqual(['ov-core', 'ov-rubber']);
    expect(line.core.getElement()?.getAttribute('fill')).toBe('none');
    expect(line.core.getElement()?.classList.contains('leaflet-interactive')).toBe(false);
    expect(line.core).toBeInstanceOf(L.Polyline);
    expect(line.core).not.toBeInstanceOf(L.Polygon);
  });

  it('adds the invalid outline at the bottom and the fill on a closed core only', () => {
    const shape = casedPath(ring, { renderer, role: 'ov-invalid', closed: true, fill: true, outline: true });
    for (const layer of shape.layers) layer.addTo(instance.map);
    expect(shape.layers.map((layer) => classesOf(layer)[0])).toEqual(['ov-outline', 'ov-casing', 'ov-core']);
    expect(classesOf(shape.core)).toEqual(['ov-core', 'ov-fill', 'ov-invalid']);
    expect(shape.core).toBeInstanceOf(L.Polygon);
    const open = casedPath(ring, { renderer, role: 'ov-own', closed: false, fill: true });
    open.core.addTo(instance.map);
    expect(classesOf(open.core)).toEqual(['ov-core', 'ov-own']);
    expect(open.core.getElement()?.getAttribute('fill')).toBe('none');
  });

  it('keeps a person colour on the core only and gives collaborators the dark casing', () => {
    const remote = casedPath(ring, {
      renderer,
      role: 'ov-remote',
      closed: true,
      fill: true,
      casing: 'remote',
      color: '#ffab61',
    });
    for (const layer of remote.layers) layer.addTo(instance.map);
    const [casing] = remote.layers;
    expect(casing?.getElement()?.getAttribute('class')).toContain('ov-casing ov-casing--remote');
    expect(casing?.getElement()?.getAttribute('stroke')).not.toBe('#ffab61');
    expect(remote.core.getElement()?.getAttribute('stroke')).toBe('#ffab61');
    expect(remote.core.getElement()?.getAttribute('fill')).toBe('#ffab61');
  });

  it('can leave the casing out (the pointer closing preview)', () => {
    const preview = casedPath(ring, { renderer, role: 'ov-closing', closed: false, casing: 'none' });
    expect(preview.layers).toEqual([preview.core]);
  });
});

describe('chipElement (UI.md section 9.8)', () => {
  it('sets the value apart in mono without changing the text content, with a decorative icon', () => {
    const chip = chipElement({
      text: 'Omer · drawing · ',
      value: '0.46 km²',
      icon: 'plus',
      title: 'Omer · drawing · 0.46 km²',
      color: '#ffab61',
      testId: 'remote-draft-chip',
      className: 'snap-chip--person',
    });
    expect(chip.textContent).toBe('Omer · drawing · 0.46 km²');
    expect(chip.querySelector('.snap-chip__value')?.textContent).toBe('0.46 km²');
    const icon = chip.querySelector('svg.snap-chip__icon');
    expect(icon?.getAttribute('aria-hidden')).toBe('true');
    expect(icon?.querySelectorAll('path')).toHaveLength(2);
    expect(chip.getAttribute('title')).toBe('Omer · drawing · 0.46 km²');
    expect(chip.style.getPropertyValue('--c')).toBe('#ffab61');
    expect(chip.classList.contains('snap-chip--person')).toBe(true);
  });

  it('shows a spinner for "Saving..." and nothing but initials on the compact disc', () => {
    const saving = chipElement({ text: 'Saving…', icon: 'spinner', testId: 'own-shape-chip' });
    expect(saving.querySelector('.spinner')?.getAttribute('aria-hidden')).toBe('');
    expect(saving.textContent).toBe('Saving…');
    const disc = chipElement({
      text: 'Dana is editing',
      icon: 'pencil',
      value: 'x',
      compact: true,
      initialsOf: 'Dana Levi',
      testId: 'lock-badge',
    });
    expect(disc.textContent).toBe('DL');
    expect(disc.querySelector('svg')).toBeNull();
    expect(disc.classList.contains('snap-chip--disc')).toBe(true);
  });
});

describe('bracketLines (UI.md section 9.4 CAD corner brackets)', () => {
  it('puts four arm-corner-arm marks `offset` px outside the box with `size` px arms', () => {
    const lines = bracketLines({ left: 100, top: 50, right: 300, bottom: 150 }, 9, 14);
    expect(lines).toEqual([
      [
        [91, 55],
        [91, 41],
        [105, 41],
      ],
      [
        [295, 41],
        [309, 41],
        [309, 55],
      ],
      [
        [309, 145],
        [309, 159],
        [295, 159],
      ],
      [
        [105, 159],
        [91, 159],
        [91, 145],
      ],
    ]);
  });
});

describe('invalidTickPositions (UI.md section 9.7 x ticks)', () => {
  it('puts a tick halfway between the crossing and each edge’s farther endpoint', () => {
    expect(
      invalidTickPositions(
        [
          [
            [0, 0],
            [10, 0],
          ],
          [
            [4, -2],
            [4, 6],
          ],
        ],
        [4, 0],
      ),
    ).toEqual([
      [7, 0],
      [4, 3],
    ]);
  });

  it('uses the edge midpoint when there is no crossing', () => {
    expect(
      invalidTickPositions(
        [
          [
            [0, 0],
            [2, 4],
          ],
        ],
        null,
      ),
    ).toEqual([[1, 2]]);
  });
});
