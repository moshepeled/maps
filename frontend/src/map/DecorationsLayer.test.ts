/**
 * Area decorations (UI.md section 9.3 - section 9.4): the selection in the accent with CAD corner brackets, hover, lock rings and
 * pulses on the collaborator casing, the history ghost and the conflict shapes.
 */
import L from 'leaflet';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { initials } from '../lib/text';
import type { AreaRecord } from '../state/areasStore';
import { recordFromDto } from '../state/areasStore';
import { areaDto, BOB, squareRing, uuid } from '../test/factories';
import type { DecorationsInput } from './DecorationsLayer';
import { DecorationsLayer } from './DecorationsLayer';
import type { MapInstance } from './mapInstance';
import { createMapInstance } from './mapInstance';

const TOKENS = {
  areaStroke: '#eef1f5',
  areaStrokeWidth: 1.75,
  areaFill: '#ffffff',
  areaFillOpacity: 0.12,
  bracketSize: 14,
  bracketOffset: 9,
};

let instance: MapInstance;
let layer: DecorationsLayer;
let area: AreaRecord;

beforeEach(() => {
  const host = document.createElement('div');
  document.body.append(host);
  instance = createMapInstance(host, 'mercator', [32.085, 34.785], 15);
  layer = new DecorationsLayer(instance.map);
  area = recordFromDto(areaDto({ id: uuid(), west: 34.78, south: 32.08, size: 0.01 }));
});

afterEach(() => {
  layer.dispose();
  instance.dispose();
  document.body.replaceChildren();
});

function input(overrides: Partial<DecorationsInput> = {}): DecorationsInput {
  return {
    selected: null,
    hover: null,
    locks: [],
    pulses: [],
    ghost: null,
    conflict: null,
    marker: null,
    selectedChip: false,
    tokens: TOKENS,
    ...overrides,
  };
}

const all = (selector: string) => [...instance.container.querySelectorAll(selector)];

describe('DecorationsLayer', () => {
  it('selection: the accent core with its fill on a casing, and four CAD corner brackets', () => {
    layer.sync(input({ selected: area }));
    expect(all('path.ov-selected.ov-core.ov-fill')).toHaveLength(1);
    expect(all('path.ov-selected.ov-casing')).toHaveLength(1);
    expect(all('path.ov-bracket.ov-core')).toHaveLength(4);
    expect(all('path.ov-bracket.ov-casing')).toHaveLength(4);
  });

  it('[N] selected chip: name + km² at the label point from zoom 14; a lock chip is kept instead', () => {
    layer.sync(input({ selected: area }));
    expect(instance.container.querySelector('.snap-chip--selected')).toBeNull();
    layer.sync(input({ selected: area, selectedChip: true }));
    const chip = instance.container.querySelector('.snap-chip--selected');
    expect(chip?.getAttribute('data-area-id')).toBe(area.id);
    expect(chip?.querySelector('.snap-chip__value')?.textContent).toMatch(/km²$/u);
    // Never collapsible: it has no person to abbreviate, and it is mine (no chip time).
    expect(chip?.hasAttribute('data-initials')).toBe(false);
    expect(chip?.hasAttribute('data-chip-time')).toBe(false);
    const lock = {
      areaId: area.id,
      holder: { userId: BOB.id, displayName: BOB.displayName, color: BOB.color },
      scope: 'geometry' as const,
      expiresAt: 1,
    };
    layer.sync(input({ selected: area, selectedChip: true, locks: [{ lock, area, both: false }] }));
    expect(instance.container.querySelector('.snap-chip--selected')).toBeNull();
    expect(
      instance.container.querySelector('[data-testid="lock-badge"]')?.getAttribute('data-initials'),
    ).toBe(initials(BOB.displayName));
  });

  it('places the brackets `offset` px outside the selection’s projected box', () => {
    layer.sync(input({ selected: area }));
    const lines: L.LatLng[][] = [];
    instance.map.eachLayer((added) => {
      if (added instanceof L.Polyline && added.options.className === 'ov-core ov-bracket')
        lines.push(added.getLatLngs() as L.LatLng[]);
    });
    expect(lines).toHaveLength(4);
    const zoom = instance.map.getZoom();
    const [west, south, east, north] = area.bbox;
    const topLeft = instance.map.project([north, west], zoom);
    const bottomRight = instance.map.project([south, east], zoom);
    const corner = instance.map.project(lines[0]?.[1] ?? [0, 0], zoom);
    expect(corner.x).toBeCloseTo(topLeft.x - 9, 6);
    expect(corner.y).toBeCloseTo(topLeft.y - 9, 6);
    const farCorner = instance.map.project(lines[2]?.[1] ?? [0, 0], zoom);
    expect(farCorner.x).toBeCloseTo(bottomRight.x + 9, 6);
    expect(farCorner.y).toBeCloseTo(bottomRight.y + 9, 6);
  });

  it('hover outlines another area; the selected area gets no hover copy', () => {
    layer.sync(input({ hover: area }));
    expect(all('path.ov-hover.ov-core')).toHaveLength(1);
    layer.sync(input({ hover: area, selected: area }));
    expect(all('path.ov-hover')).toHaveLength(0);
  });

  it('a lock is a dashed ring in the holder’s colour on the dark casing, with a pencil chip', () => {
    layer.sync(
      input({
        locks: [
          {
            lock: {
              areaId: area.id,
              holder: { userId: BOB.id, displayName: BOB.displayName, color: BOB.color },
              scope: 'geometry',
              expiresAt: 1,
            },
            area,
            both: false,
          },
        ],
      }),
    );
    const [ring] = all('path.ov-lock.ov-core');
    expect(ring?.getAttribute('stroke')).toBe(BOB.color);
    expect(all('path.ov-lock.ov-casing.ov-casing--remote')).toHaveLength(1);
    const chip = instance.container.querySelector('[data-testid="lock-badge"]');
    expect(chip?.getAttribute('data-compact')).toBe('false');
    expect(chip?.querySelector('svg.snap-chip__icon')).not.toBeNull();
  });

  it('pulses in the actor’s colour: animated, or a static ring with the "updated" chip', () => {
    const pulse = { areaId: area.id, color: BOB.color, userId: BOB.id, userName: BOB.displayName, until: 9 };
    layer.sync(input({ pulses: [{ pulse: { ...pulse, staticRing: false }, area }] }));
    expect(all('path.ov-pulse.ov-core')[0]?.getAttribute('stroke')).toBe(BOB.color);
    expect(all('path.ov-pulse.ov-casing--remote')).toHaveLength(1);
    // A later change with reduced motion on (a pulse is static or animated for its whole life).
    layer.sync(input({ pulses: [{ pulse: { ...pulse, until: 12, staticRing: true }, area }] }));
    expect(all('path.ov-pulse-static.ov-core')).toHaveLength(1);
    expect(instance.container.querySelector('[data-testid="updated-chip"]')).not.toBeNull();
    // A system change has no actor: it pulses in the tone's saved-area colour, never a fixed near-black.
    layer.sync(
      input({
        pulses: [
          {
            pulse: { ...pulse, color: null, userId: null, userName: null, until: 15, staticRing: true },
            area,
          },
        ],
      }),
    );
    expect(all('path.ov-pulse-static.ov-core')[0]?.getAttribute('stroke')).toBe(TOKENS.areaStroke);
  });

  it('keeps the ghost and conflict test ids on the visible cores', () => {
    const ring = squareRing(34.78, 32.08, 0.005);
    layer.sync(
      input({
        ghost: [ring],
        conflict: { mine: [ring], theirs: [ring], theirsColor: BOB.color, theirsName: BOB.displayName },
      }),
    );
    expect(
      instance.container.querySelector('[data-testid="history-ghost"]')?.getAttribute('class'),
    ).toContain('ov-core ov-fill ov-ghost');
    const theirs = instance.container.querySelector('[data-testid="conflict-theirs"]');
    expect(theirs?.getAttribute('class')).toContain('ov-core ov-theirs');
    expect(theirs?.getAttribute('stroke')).toBe(BOB.color);
    expect(
      instance.container.querySelector('[data-testid="conflict-mine"]')?.getAttribute('class'),
    ).toContain('ov-core ov-fill ov-mine');
  });
});
