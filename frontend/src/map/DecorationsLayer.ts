/**
 * Per-area decorations drawn as SVG copies around the canvas (UI.md section 9.3 - section 9.4, UX section 3.3): the hover outline, the
 * selection in the accent with its glow and CAD corner brackets (never re-ordering the canvas, UX-AC-108), lock rings
 * in the holder's colour with their chips (collapsing to an initials disc on small areas, never removed), pulses in
 * the actor's colour (or a static ring + "updated" chip with reduced motion), the history preview ghost and the
 * conflict shapes. Every line is a core on a casing; collaborator colours keep the dark casing.
 */
import type { Position } from '@snapland/shared';
import L from 'leaflet';

import { base } from '../base/en';
import { formatArea } from '../lib/format';
import { displayName, displayUser } from '../lib/text';
import type { AreaRecord } from '../state/areasStore';
import type { Pulse } from '../state/effectsStore';
import type { AreaLock } from '../state/locksStore';
import { PANES } from './mapInstance';
import type { ScreenBox } from './mapInsets';
import type { CasedPath, OverlayTokens } from './overlayUtil';
import {
  bracketLines,
  casedPath,
  chipElement,
  chipMarker,
  invalidMarker,
  labelPoint,
  tagLayer,
  toLatLng,
  toLatLngs,
} from './overlayUtil';

export interface DecorationsInput {
  selected: AreaRecord | null;
  hover: AreaRecord | null;
  locks: readonly { lock: AreaLock; area: AreaRecord; both: boolean }[];
  pulses: readonly { pulse: Pulse; area: AreaRecord }[];
  ghost: Position[][] | null;
  conflict: {
    mine: Position[][] | null;
    theirs: Position[][] | null;
    theirsColor: string;
    theirsName: string;
  } | null;
  /** A server-reported problem location on my edit (422, UX F-04 step 8). */
  marker: Position | null;
  /** The [N] selected chip (name + km² at the label point) is shown at Web-Mercator zoom >= 14 (UI.md section 9.8). */
  selectedChip: boolean;
  tokens: OverlayTokens;
}

const MIN_CHIP_AREA_PX = 24;

function rings(area: { rings: Position[][] }): L.LatLngTuple[][] {
  return area.rings.map((ring) => toLatLngs(ring));
}

export class DecorationsLayer {
  private readonly svg: Record<'selection' | 'locks' | 'pulse' | 'history' | 'remote', L.SVG>;
  private group = L.layerGroup();
  private signature = '';

  constructor(private readonly map: L.Map) {
    this.svg = {
      selection: L.svg({ pane: PANES.selection.name }),
      locks: L.svg({ pane: PANES.locks.name }),
      pulse: L.svg({ pane: PANES.pulse.name }),
      history: L.svg({ pane: PANES.history.name }),
      remote: L.svg({ pane: PANES.remote.name }),
    };
    this.group.addTo(map);
  }

  /** Rebuilds the (few) decoration layers when their inputs change; cheap because they are a handful of paths. */
  sync(input: DecorationsInput): void {
    const signature = this.signatureOf(input);
    if (signature === this.signature) return;
    this.signature = signature;
    this.group.clearLayers();
    this.drawPulses(input);
    this.drawLocks(input);
    this.drawSelection(input);
    this.drawGhost(input);
    this.drawConflict(input);
    if (input.marker !== null) this.group.addLayer(invalidMarker(toLatLng(input.marker)));
  }

  private signatureOf(input: DecorationsInput): string {
    return JSON.stringify([
      input.selected?.id,
      input.selected?.version,
      input.hover?.id,
      input.hover?.version,
      input.locks.map(({ lock, area, both }) => [
        lock.areaId,
        lock.holder.userId,
        lock.expiresAt,
        area.version,
        both,
      ]),
      input.pulses.map(({ pulse, area }) => [pulse.areaId, pulse.until, area.version]),
      input.ghost?.length,
      input.ghost?.[0]?.[0],
      input.conflict === null
        ? null
        : [input.conflict.mine?.[0]?.length, input.conflict.theirs?.[0]?.length, input.conflict.theirsName],
      input.marker,
      input.selectedChip,
      input.tokens,
      // Brackets and compact lock chips are measured in screen pixels.
      this.map.getZoom(),
    ]);
  }

  private add({ layers }: CasedPath): void {
    for (const layer of layers) this.group.addLayer(layer);
  }

  private drawSelection(input: DecorationsInput): void {
    const { hover, selected } = input;
    const renderer = this.svg.selection;
    if (hover !== null && hover.id !== selected?.id)
      this.add(casedPath(rings(hover), { renderer, role: 'ov-hover', closed: true, fill: true }));
    if (selected === null) return;
    this.add(casedPath(rings(selected), { renderer, role: 'ov-selected', closed: true, fill: true }));
    this.drawBrackets(selected, input.tokens);
    this.drawSelectedChip(selected, input);
  }

  /**
   * The [N] selected chip (UI.md section 9.4, section 9.8): the name and km² at the label point, a neutral plate with the "me"
   * swatch. A lock or "updated" chip already sits on that label point and is kept instead (section 9.3 "lock chip kept").
   */
  private drawSelectedChip(area: AreaRecord, input: DecorationsInput): void {
    if (!input.selectedChip) return;
    const labelled =
      input.locks.some(({ area: locked }) => locked.id === area.id) ||
      input.pulses.some(({ pulse, area: pulsed }) => pulsed.id === area.id && pulse.staticRing);
    if (labelled) return;
    const name = displayName(area.name);
    const chip = chipElement({
      text: name,
      value: formatArea(area.areaKm2),
      title: `${area.name} · ${formatArea(area.areaKm2)}`,
      className: 'snap-chip--neutral snap-chip--selected snap-chip--centred',
      attributes: { 'data-area-id': area.id, dir: 'auto', 'aria-hidden': true },
    });
    this.group.addLayer(chipMarker(labelPoint(area.bbox), chip));
  }

  /**
   * CAD corner brackets around the selection's screen bounding box (UI.md section 9.4), a pattern that says "selected"
   * without colour. They are built in projected pixels at the current zoom, so a pan keeps them in place and only a
   * zoom rebuilds them (map.css hides them during the zoom animation).
   */
  private drawBrackets(area: AreaRecord, tokens: OverlayTokens): void {
    const zoom = this.map.getZoom();
    const box: ScreenBox = { left: Infinity, top: Infinity, right: -Infinity, bottom: -Infinity };
    for (const ring of area.rings) {
      for (const position of ring) {
        const point = this.map.project(toLatLng(position), zoom);
        box.left = Math.min(box.left, point.x);
        box.top = Math.min(box.top, point.y);
        box.right = Math.max(box.right, point.x);
        box.bottom = Math.max(box.bottom, point.y);
      }
    }
    if (!Number.isFinite(box.left)) return;
    for (const line of bracketLines(box, tokens.bracketOffset, tokens.bracketSize)) {
      const latlngs = line.map(([x, y]) => this.map.unproject([x, y], zoom));
      this.add(casedPath(latlngs, { renderer: this.svg.selection, role: 'ov-bracket', closed: false }));
    }
  }

  private areaPixelSize(area: AreaRecord): number {
    const [west, south, east, north] = area.bbox;
    const a = this.map.latLngToContainerPoint([south, west]);
    const b = this.map.latLngToContainerPoint([north, east]);
    return Math.max(Math.abs(b.x - a.x), Math.abs(b.y - a.y));
  }

  private drawLocks(input: DecorationsInput): void {
    for (const { lock, area, both } of input.locks) {
      this.add(
        casedPath(rings(area), {
          renderer: this.svg.locks,
          role: 'ov-lock',
          closed: true,
          casing: 'remote',
          color: lock.holder.color,
        }),
      );
      const compact = this.areaPixelSize(area) < MIN_CHIP_AREA_PX;
      const user = displayUser(lock.holder.displayName);
      const full = both
        ? base.lock.chipBoth(lock.holder.displayName)
        : base.lock.badge(lock.holder.displayName);
      const text = both ? base.lock.chipBoth(user) : base.lock.badge(user);
      const chip = chipElement({
        text,
        title: full,
        icon: 'pencil',
        color: lock.holder.color,
        testId: 'lock-badge',
        compact,
        initialsOf: lock.holder.displayName,
        time: lock.expiresAt,
        className: 'snap-chip--person snap-chip--centred',
        attributes: {
          'data-area-id': area.id,
          'data-user-id': lock.holder.userId,
          'data-compact': compact ? 'true' : 'false',
          'data-variant': both ? 'both' : 'other',
          'aria-label': full,
        },
      });
      this.group.addLayer(chipMarker(labelPoint(area.bbox), chip));
    }
  }

  private drawPulses(input: DecorationsInput): void {
    for (const { pulse, area } of input.pulses) {
      this.add(
        casedPath(rings(area), {
          renderer: this.svg.pulse,
          role: pulse.staticRing ? 'ov-pulse-static' : 'ov-pulse',
          closed: true,
          casing: 'remote',
          // A system change (no actor) pulses in the saved-area colour of the current map tone.
          color: pulse.color ?? input.tokens.areaStroke,
        }),
      );
      if (pulse.staticRing && pulse.userName !== null) {
        const chip = chipElement({
          text: base.collab.updatedChip(displayUser(pulse.userName)),
          title: base.collab.updatedChip(pulse.userName),
          color: pulse.color,
          testId: 'updated-chip',
          initialsOf: pulse.userName,
          time: pulse.until,
          className: 'snap-chip--person snap-chip--centred',
          attributes: { 'data-area-id': area.id, 'data-user-id': pulse.userId ?? undefined },
        });
        this.group.addLayer(chipMarker(labelPoint(area.bbox), chip));
      }
    }
  }

  private drawGhost(input: DecorationsInput): void {
    if (input.ghost === null) return;
    const ghost = casedPath(
      input.ghost.map((ring) => toLatLngs(ring)),
      { renderer: this.svg.history, role: 'ov-ghost', closed: true, fill: true },
    );
    this.add(ghost);
    tagLayer(ghost.core, { 'data-testid': 'history-ghost' });
  }

  private drawConflict(input: DecorationsInput): void {
    const conflict = input.conflict;
    if (conflict === null) return;
    if (conflict.theirs !== null) {
      const theirs = casedPath(
        conflict.theirs.map((ring) => toLatLngs(ring)),
        {
          renderer: this.svg.remote,
          role: 'ov-theirs',
          closed: true,
          casing: 'remote',
          color: conflict.theirsColor,
        },
      );
      this.add(theirs);
      tagLayer(theirs.core, { 'data-testid': 'conflict-theirs' });
    }
    if (conflict.mine !== null) {
      const mine = casedPath(
        conflict.mine.map((ring) => toLatLngs(ring)),
        { renderer: this.svg.remote, role: 'ov-mine', closed: true, fill: true },
      );
      this.add(mine);
      tagLayer(mine.core, { 'data-testid': 'conflict-mine' });
    }
  }

  dispose(): void {
    this.group.remove();
    for (const renderer of Object.values(this.svg)) renderer.remove();
  }
}
