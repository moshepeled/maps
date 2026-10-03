/**
 * Other users' live drafts (UX C-07, UI.md section 9.5): a dashed outline in the author's colour on the dark collaborator
 * casing, a light fill and point dots, the streamed rubber-band to their cursor (hidden in Quiet mode), a paused look
 * after 10 s without a new rev, and a person chip at their latest point - "Omer, drawing, 0.46 km²", without the
 * km² below 600 px (the receiver-computed value always stays in `remote-draft-chip[data-km2]`). Non-interactive.
 */
import L from 'leaflet';

import { base } from '../base/en';
import { formatArea } from '../lib/format';
import { displayUser } from '../lib/text';
import type { RemoteDraft } from '../state/remoteDraftsStore';
import { remoteDraftAreaKm2 } from '../state/remoteDraftsStore';
import { PANES } from './mapInstance';
import type { ChipOptions } from './overlayUtil';
import {
  anchoredMarker,
  casedPath,
  chipElement,
  chipMarker,
  tagLayer,
  toLatLng,
  toLatLngs,
} from './overlayUtil';
import { groupElement, withPersonColor } from './safe-dom';

export interface RemoteDraftView {
  draft: RemoteDraft;
  idle: boolean;
}

interface Entry {
  key: string;
  group: L.LayerGroup;
}

/** The chip's words (UX C-07): what the author is doing, and their live km² as a separate mono value when shown. */
export function remoteChipContent(
  draft: RemoteDraft,
  km2: number,
  { idle, narrow }: { idle: boolean; narrow: boolean },
): Pick<ChipOptions, 'text' | 'value' | 'icon' | 'title'> {
  const user = displayUser(draft.user.displayName);
  if (draft.areaId !== null) {
    const text = base.collab.editChip(user);
    return { text, title: text, icon: 'pencil' };
  }
  if (idle) {
    const text = base.collab.draftIdle(user);
    return { text, title: text };
  }
  if (narrow) {
    const text = base.collab.draftChip(user);
    return { text, title: text, icon: 'plus' };
  }
  const pointCount = draft.vertices.length + (draft.cursor === null ? 0 : 1);
  const area = pointCount >= 3 ? formatArea(km2) : '—';
  const full = base.collab.draftChipArea(user, area);
  // The copy ends with the area: split it off so it is set in mono (the chip's text content stays the same).
  if (!full.endsWith(area)) return { text: full, title: full, icon: 'plus' };
  return { text: full.slice(0, full.length - area.length), value: area, title: full, icon: 'plus' };
}

function pointDot(color: string, idle: boolean): HTMLElement {
  const dot = groupElement('span', [], { class: `snap-dot${idle ? ' is-idle' : ''}`, 'aria-hidden': true });
  return withPersonColor(dot, color);
}

export class RemoteDraftsLayer {
  private readonly svg: L.SVG;
  private readonly entries = new Map<string, Entry>();

  constructor(private readonly map: L.Map) {
    this.svg = L.svg({ pane: PANES.remote.name });
  }

  sync(drafts: readonly RemoteDraftView[], options: { quiet: boolean; narrow: boolean }): void {
    const seen = new Set<string>();
    for (const view of drafts) {
      seen.add(view.draft.draftId);
      const key = JSON.stringify([
        view.draft.rev,
        view.draft.cursor,
        view.idle,
        view.draft.committedAt !== null,
        options.quiet,
        options.narrow,
        view.draft.vertices.length,
      ]);
      const existing = this.entries.get(view.draft.draftId);
      if (existing?.key === key) continue;
      existing?.group.remove();
      this.entries.set(view.draft.draftId, { key, group: this.build(view, options) });
    }
    for (const [draftId, entry] of this.entries) {
      if (!seen.has(draftId)) {
        entry.group.remove();
        this.entries.delete(draftId);
      }
    }
  }

  private build(
    { draft, idle }: RemoteDraftView,
    options: { quiet: boolean; narrow: boolean },
  ): L.LayerGroup {
    const group = L.layerGroup().addTo(this.map);
    const color = draft.user.color;
    const latlngs = toLatLngs(draft.vertices);
    const shape = casedPath(latlngs, {
      renderer: this.svg,
      role: idle ? 'ov-remote is-idle' : 'ov-remote',
      closed: latlngs.length >= 3,
      casing: 'remote',
      fill: true,
      color,
    });
    for (const layer of shape.layers) group.addLayer(layer);
    tagLayer(shape.core, {
      'data-testid': 'remote-draft',
      'data-user-id': draft.user.id,
      'data-area-id': draft.areaId ?? undefined,
      'data-draft-id': draft.draftId,
      'data-idle': idle ? 'true' : 'false',
    });
    for (const vertex of latlngs)
      group.addLayer(anchoredMarker(vertex, pointDot(color, idle), 'remotePoints'));
    const last = draft.vertices.at(-1);
    if (draft.cursor !== null && last !== undefined && !options.quiet) {
      const band = casedPath([toLatLng(last), toLatLng(draft.cursor)], {
        renderer: this.svg,
        role: 'ov-remote-band',
        closed: false,
        casing: 'remote',
        color,
      });
      for (const layer of band.layers) group.addLayer(layer);
      tagLayer(band.core, { 'data-testid': 'remote-rubber-band', 'data-user-id': draft.user.id });
    }
    const anchor = last ?? draft.cursor;
    if (anchor !== null) {
      const km2 = remoteDraftAreaKm2(draft);
      const chip = chipElement({
        ...remoteChipContent(draft, km2, { idle, narrow: options.narrow }),
        color,
        testId: 'remote-draft-chip',
        // Collapsible to the author's initials; the latest rev makes it the newer of two overlapping chips.
        initialsOf: draft.user.displayName,
        time: draft.lastRevChangeAt,
        className: `snap-chip--person${idle ? ' snap-chip--outline' : ''}`,
        attributes: {
          'data-user-id': draft.user.id,
          'data-area-id': draft.areaId ?? undefined,
          'data-idle': idle ? 'true' : 'false',
          'data-km2': km2,
        },
      });
      group.addLayer(chipMarker(toLatLng(anchor), chip));
    }
    return group;
  }

  dispose(): void {
    for (const entry of this.entries.values()) entry.group.remove();
    this.entries.clear();
    this.svg.remove();
  }
}
