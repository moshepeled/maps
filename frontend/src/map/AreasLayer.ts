/**
 * Saved areas on one canvas (SPEC section 8.6 "Rendering", UI.md section 9.1): diffed by id + version, drawn largest first so
 * nested smaller areas stay on top - an order that is never changed afterwards (selection and hover are separate
 * SVG copies). The canvas layers are non-interactive: hit-testing is done by the map controller on lat/lng, which is
 * cheaper at 10k+ areas and independent of the renderer.
 */
import type { Bbox } from '@snapland/shared';
import { bboxesIntersect } from '@snapland/shared';
import L from 'leaflet';

import type { AreaRecord } from '../state/areasStore';
import { PANES } from './mapInstance';
import type { OverlayTokens } from './overlayUtil';
import { toLatLngs } from './overlayUtil';

interface Entry {
  layer: L.Polygon;
  version: number;
  precision: number;
  areaKm2: number;
}

/**
 * Saved areas are one calm neutral (UI.md section 9.3): white on the dark map tone, slate on the light one. The canvas cannot
 * read CSS, so the colours come from the tokens; the dark or white casing is a filter on the canvas (map.css).
 */
function areaStyle(tokens: OverlayTokens): L.PathOptions {
  return {
    color: tokens.areaStroke,
    weight: tokens.areaStrokeWidth,
    fillColor: tokens.areaFill,
    fillOpacity: tokens.areaFillOpacity,
    lineJoin: 'round',
    lineCap: 'round',
  };
}

export class AreasLayer {
  private readonly renderer: L.Canvas;
  private readonly entries = new Map<string, Entry>();
  private tokens: OverlayTokens | null = null;

  constructor(private readonly map: L.Map) {
    this.renderer = L.canvas({ pane: PANES.areas.name, padding: 0.5 });
  }

  /** Brings the canvas in line with the store: only areas near the viewport are materialised. */
  sync(
    areas: ReadonlyMap<string, AreaRecord>,
    viewport: Bbox | null,
    tokens: OverlayTokens,
    hidden: ReadonlySet<string>,
  ): number {
    const started = performance.now();
    const restyle = this.tokens !== tokens;
    this.tokens = tokens;
    const style = areaStyle(tokens);
    const wanted = new Map<string, AreaRecord>();
    for (const area of areas.values()) {
      if (hidden.has(area.id)) continue;
      if (viewport === null || bboxesIntersect(area.bbox, viewport)) wanted.set(area.id, area);
    }
    for (const [id, entry] of this.entries) {
      if (!wanted.has(id)) {
        entry.layer.remove();
        this.entries.delete(id);
      }
    }
    let added = false;
    for (const area of wanted.values()) {
      const entry = this.entries.get(area.id);
      if (entry?.version === area.version && entry.precision === area.precision) {
        if (restyle) entry.layer.setStyle(style);
        continue;
      }
      if (entry !== undefined) entry.layer.remove();
      const layer = L.polygon(
        area.rings.map((ring) => toLatLngs(ring)),
        { ...style, renderer: this.renderer, interactive: false, pane: PANES.areas.name },
      );
      layer.addTo(this.map);
      this.entries.set(area.id, {
        layer,
        version: area.version,
        precision: area.precision,
        areaKm2: area.areaKm2,
      });
      added = true;
    }
    if (added) this.reorder();
    return performance.now() - started;
  }

  /** Larger first (UX section 3.3): re-stack once per batch that added areas. */
  private reorder(): void {
    const ordered = [...this.entries.entries()].sort(
      ([leftId, left], [rightId, right]) => right.areaKm2 - left.areaKm2 || leftId.localeCompare(rightId),
    );
    for (const [, entry] of ordered) entry.layer.bringToFront();
  }

  dispose(): void {
    for (const entry of this.entries.values()) entry.layer.remove();
    this.entries.clear();
    this.renderer.remove();
  }
}
