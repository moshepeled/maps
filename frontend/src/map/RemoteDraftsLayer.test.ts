/**
 * Others' drafts (UX C-07, UI.md section 9.5): dashed in their colour on the dark collaborator casing, with point dots, the
 * streamed rubber-band and the "Name, drawing, km²" chip (no km² below 600 px; always in `data-km2`).
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { base } from '../base/en';
import { formatArea } from '../lib/format';
import type { RemoteDraft } from '../state/remoteDraftsStore';
import { remoteDraftAreaKm2 } from '../state/remoteDraftsStore';
import { BOB } from '../test/factories';
import type { MapInstance } from './mapInstance';
import { createMapInstance, PANES } from './mapInstance';
import { RemoteDraftsLayer, remoteChipContent } from './RemoteDraftsLayer';

function draft(overrides: Partial<RemoteDraft> = {}): RemoteDraft {
  return {
    draftId: 'draft-1',
    user: { id: BOB.id, displayName: 'Omer Cohen', color: '#ffab61' },
    areaId: null,
    rev: 3,
    vertices: [
      [34.78, 32.08],
      [34.79, 32.08],
      [34.79, 32.09],
    ],
    cursor: [34.78, 32.09],
    lastMessageAt: 0,
    lastRevChangeAt: 0,
    committedAt: null,
    committedAreaId: null,
    ...overrides,
  };
}

describe('remoteChipContent', () => {
  const wide = { idle: false, narrow: false };

  it('splits the live km² off as a mono value, keeping the copy as the text content and title', () => {
    const value = draft();
    const km2 = remoteDraftAreaKm2(value);
    const content = remoteChipContent(value, km2, wide);
    const full = base.collab.draftChipArea('Omer Cohen', formatArea(km2));
    expect(`${content.text}${content.value ?? ''}`).toBe(full);
    expect(content.value).toBe(formatArea(km2));
    expect(content).toMatchObject({ title: full, icon: 'plus' });
  });

  it('drops the km² below 600 px, and shows " - " until there are three points', () => {
    expect(remoteChipContent(draft(), 0.5, { idle: false, narrow: true })).toEqual({
      text: base.collab.draftChip('Omer Cohen'),
      title: base.collab.draftChip('Omer Cohen'),
      icon: 'plus',
    });
    expect(remoteChipContent(draft({ vertices: [[34.78, 32.08]] }), 0, wide).value).toBe('—');
  });

  it('paused drafts get no icon (the outline chip has a dot), edit drafts a pencil', () => {
    expect(remoteChipContent(draft(), 0.5, { idle: true, narrow: false })).toEqual({
      text: base.collab.draftIdle('Omer Cohen'),
      title: base.collab.draftIdle('Omer Cohen'),
    });
    expect(remoteChipContent(draft({ areaId: 'area-1' }), 0.5, wide)).toMatchObject({
      text: base.collab.editChip('Omer Cohen'),
      icon: 'pencil',
    });
  });
});

describe('RemoteDraftsLayer', () => {
  let instance: MapInstance;
  let layer: RemoteDraftsLayer;

  beforeEach(() => {
    const host = document.createElement('div');
    document.body.append(host);
    instance = createMapInstance(host, 'mercator', [32.085, 34.785], 15);
    layer = new RemoteDraftsLayer(instance.map);
  });

  afterEach(() => {
    layer.dispose();
    instance.dispose();
    document.body.replaceChildren();
  });

  const all = (selector: string) => [...instance.container.querySelectorAll(selector)];
  const one = (selector: string) => instance.container.querySelector(selector);

  it('draws their dashed shape in their colour on the dark casing, dots above it, the band and the chip', () => {
    layer.sync([{ draft: draft(), idle: false }], { quiet: false, narrow: false });
    const shape = one('[data-testid="remote-draft"]');
    expect(shape?.getAttribute('class')).toContain('ov-core ov-fill ov-remote');
    expect(shape?.getAttribute('stroke')).toBe('#ffab61');
    expect(shape?.getAttribute('data-idle')).toBe('false');
    expect(all('path.ov-remote.ov-casing.ov-casing--remote')).toHaveLength(1);
    const dots = instance.map.getPane(PANES.remotePoints.name)?.querySelectorAll('.snap-dot');
    expect(dots).toHaveLength(3);
    expect((dots?.[0] as HTMLElement).style.getPropertyValue('--c')).toBe('#ffab61');
    const band = one('[data-testid="remote-rubber-band"]');
    expect(band?.getAttribute('class')).toContain('ov-core ov-remote-band');
    expect(all('path.ov-remote-band.ov-casing--remote')).toHaveLength(1);
    const chip = one('[data-testid="remote-draft-chip"]');
    const km2 = remoteDraftAreaKm2(draft());
    expect(chip?.textContent).toBe(base.collab.draftChipArea('Omer Cohen', formatArea(km2)));
    expect(chip?.getAttribute('data-km2')).toBe(String(km2));
    expect(chip?.querySelector('.snap-chip__value')).not.toBeNull();
    expect(chip?.querySelector('svg.snap-chip__icon')).not.toBeNull();
  });

  it('paused: shape and dots dim, the chip becomes an outline chip; Quiet mode hides the band', () => {
    layer.sync([{ draft: draft(), idle: true }], { quiet: true, narrow: false });
    expect(one('[data-testid="remote-draft"]')?.classList.contains('is-idle')).toBe(true);
    expect(all('.snap-dot.is-idle')).toHaveLength(3);
    expect(one('[data-testid="remote-rubber-band"]')).toBeNull();
    const chip = one('[data-testid="remote-draft-chip"]');
    expect(chip?.classList.contains('snap-chip--outline')).toBe(true);
    expect(chip?.textContent).toBe(base.collab.draftIdle('Omer Cohen'));
  });

  it('below 600 px the chip text leaves the km² out but keeps data-km2', () => {
    layer.sync([{ draft: draft(), idle: false }], { quiet: false, narrow: true });
    const chip = one('[data-testid="remote-draft-chip"]');
    expect(chip?.textContent).toBe(base.collab.draftChip('Omer Cohen'));
    expect(chip?.getAttribute('data-km2')).toBe(String(remoteDraftAreaKm2(draft())));
  });
});
