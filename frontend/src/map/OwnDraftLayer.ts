/**
 * My new-area drawing on the map (UX C-06, UI.md section 9.5): my shape in the accent ("me") from the first point to the
 * save. While drawing with a pointer: solid placed edges, a dashed rubber-band to the pointer and a dotted closing
 * preview back to the first point, with the fill previewing the provisional point. Without a pointer (touch, or the
 * pointer off the map) the placed points show closed, with a dotted closing edge on a casing. Also the point glyphs
 * (first as a ring, last with a glow, small dots once finished), the invalid styling (colour AND pattern:
 * `invalid-edge`, x ticks, `invalid-marker`), and the "Unsaved" / "Saving..." chip (`own-shape-chip[data-state]`).
 */
import type { Position } from '@snapland/shared';
import L from 'leaflet';

import { base } from '../base/en';
import { PANES } from './mapInstance';
import {
  anchoredMarker,
  casedPath,
  chipElement,
  chipMarker,
  invalidMarker,
  invalidTickMarker,
  invalidTickPositions,
  tagLayer,
  toLatLng,
  toLatLngs,
} from './overlayUtil';
import type { CasedPath } from './overlayUtil';
import { groupElement } from './safe-dom';

export interface OwnDraftInput {
  stage: 'drawing' | 'finished' | 'saving' | 'hidden';
  points: readonly Position[];
  /** The point the readout includes (placeable pointer), or null. */
  provisional: Position | null;
  /** The pointer or keyboard reticle the rubber-band follows; null off the map and on touch (no hover). */
  pointer: Position | null;
  invalid: { edges: [Position, Position][]; marker: Position | null } | null;
  /** A server-reported problem location (422 on save). */
  serverMarker: Position | null;
  firstPointHot: boolean;
}

type PointKind = 'first' | 'last' | 'placed' | 'unsaved';

/** Which glyph a point gets (UI.md section 9.5): finished shapes keep small dots, the "unsaved" marker. */
export function pointKind(stage: OwnDraftInput['stage'], index: number, count: number): PointKind {
  if (stage !== 'drawing') return 'unsaved';
  if (index === 0) return 'first';
  return index === count - 1 ? 'last' : 'placed';
}

function pointGlyph(kind: PointKind, hot: boolean): HTMLElement {
  return groupElement('span', [], {
    class: `snap-point snap-point--${kind}${hot ? ' is-hot' : ''}`,
    'aria-hidden': true,
  });
}

export class OwnDraftLayer {
  private readonly svg: L.SVG;
  /** Paths, markers and the chip: rebuilt whenever anything changes (a handful of elements). */
  private readonly shape = L.layerGroup();
  /** One glyph per point (up to ~2,000): rebuilt only when the points change, not on every pointer frame. */
  private readonly points = L.layerGroup();
  private shapeSignature = '';
  private drawnPoints: readonly Position[] | null = null;
  private drawnPointsLook = '';

  constructor(map: L.Map) {
    this.svg = L.svg({ pane: PANES.own.name });
    this.shape.addTo(map);
    this.points.addTo(map);
  }

  sync(input: OwnDraftInput): void {
    const visible = input.stage !== 'hidden' && input.points.length > 0;
    this.syncPoints(visible ? input : null);
    const signature = visible
      ? JSON.stringify([
          input.stage,
          input.points,
          input.provisional,
          input.pointer,
          input.invalid,
          input.serverMarker,
        ])
      : '';
    if (signature === this.shapeSignature) return;
    this.shapeSignature = signature;
    this.shape.clearLayers();
    if (!visible) return;
    this.drawShape(input);
    if (input.stage === 'drawing') {
      if (input.pointer === null) this.drawClosingEdge(input);
      else this.drawPreview(input, input.pointer);
    }
    this.drawInvalid(input);
    if (input.stage !== 'drawing') this.drawChip(input);
  }

  private add({ layers }: CasedPath): void {
    for (const layer of layers) this.shape.addLayer(layer);
  }

  private tagShape(layer: L.Path, input: OwnDraftInput): void {
    tagLayer(layer, {
      'data-testid': 'own-draft',
      'data-points': input.points.length,
      'data-state': input.stage,
    });
  }

  private drawShape(input: OwnDraftInput): void {
    const renderer = this.svg;
    if (input.stage === 'drawing') {
      // The fill previews the would-be shape (it includes the provisional point); the edges show only what is placed.
      const ring = input.provisional === null ? input.points : [...input.points, input.provisional];
      const fillOptions: L.PolylineOptions = {
        renderer,
        interactive: false,
        stroke: false,
        className: 'ov-fill ov-own',
      };
      const fill =
        ring.length >= 3 ? L.polygon(toLatLngs(ring), fillOptions) : L.polyline(toLatLngs(ring), fillOptions);
      this.shape.addLayer(fill);
      this.tagShape(fill, input);
      if (input.points.length >= 2)
        this.add(casedPath(toLatLngs(input.points), { renderer, role: 'ov-own', closed: false }));
      return;
    }
    const shape = casedPath(toLatLngs(input.points), {
      renderer,
      role: input.stage === 'saving' ? 'ov-own is-saving' : 'ov-own',
      closed: input.points.length >= 3,
      fill: true,
    });
    this.add(shape);
    this.tagShape(shape.core, input);
  }

  /** Rubber-band (last point -> pointer) and closing preview (pointer -> first point, no casing). */
  private drawPreview(input: OwnDraftInput, pointer: Position): void {
    const last = input.points.at(-1);
    const first = input.points[0];
    if (last === undefined || first === undefined) return;
    const invalid = input.invalid !== null && input.provisional === null;
    this.add(
      casedPath([toLatLng(last), toLatLng(pointer)], {
        renderer: this.svg,
        role: invalid ? 'ov-invalid' : 'ov-rubber',
        closed: false,
        outline: invalid,
      }),
    );
    if (input.points.length >= 2) {
      this.add(
        casedPath([toLatLng(pointer), toLatLng(first)], {
          renderer: this.svg,
          role: 'ov-closing',
          closed: false,
          casing: 'none',
        }),
      );
    }
  }

  /** No pointer: the placed points shown closed, the closing edge dotted on a casing (UX C-06.4, UI.md section 9.5). */
  private drawClosingEdge(input: OwnDraftInput): void {
    const last = input.points.at(-1);
    const first = input.points[0];
    if (input.points.length < 3 || last === undefined || first === undefined) return;
    this.add(
      casedPath([toLatLng(last), toLatLng(first)], {
        renderer: this.svg,
        role: 'ov-closing is-closed',
        closed: false,
      }),
    );
  }

  private drawInvalid(input: OwnDraftInput): void {
    const invalid = input.invalid;
    if (invalid !== null) {
      for (const [a, b] of invalid.edges) {
        const edge = casedPath([toLatLng(a), toLatLng(b)], {
          renderer: this.svg,
          role: 'ov-invalid',
          closed: false,
          outline: true,
        });
        this.add(edge);
        tagLayer(edge.core, { 'data-testid': 'invalid-edge' });
      }
      for (const tick of invalidTickPositions(invalid.edges, invalid.marker))
        this.shape.addLayer(invalidTickMarker(toLatLng(tick)));
      if (invalid.marker !== null) this.shape.addLayer(invalidMarker(toLatLng(invalid.marker)));
    }
    if (input.serverMarker !== null) this.shape.addLayer(invalidMarker(toLatLng(input.serverMarker)));
  }

  private drawChip(input: OwnDraftInput): void {
    const lats = input.points.map(([, lat]) => lat);
    const lngs = input.points.map(([lng]) => lng);
    const centre: L.LatLngTuple = [
      (Math.min(...lats) + Math.max(...lats)) / 2,
      (Math.min(...lngs) + Math.max(...lngs)) / 2,
    ];
    const saving = input.stage === 'saving';
    const chip = chipElement({
      text: saving ? base.save.savingChip : base.save.unsavedChip,
      testId: 'own-shape-chip',
      className: 'snap-chip--neutral snap-chip--centred',
      attributes: { 'data-state': saving ? 'saving' : 'unsaved' },
      icon: saving ? 'spinner' : undefined,
    });
    this.shape.addLayer(chipMarker(centre, chip));
  }

  /** Compares the points array by reference: the drawing store replaces it on every change, never on a pointer move. */
  private syncPoints(input: OwnDraftInput | null): void {
    const points = input?.points ?? null;
    const look = input === null ? '' : `${input.stage}|${String(input.firstPointHot)}`;
    if (points === this.drawnPoints && look === this.drawnPointsLook) return;
    this.drawnPoints = points;
    this.drawnPointsLook = look;
    this.points.clearLayers();
    if (input === null) return;
    const count = input.points.length;
    input.points.forEach((point, index) => {
      const kind = pointKind(input.stage, index, count);
      const glyph = pointGlyph(kind, kind === 'first' && input.firstPointHot);
      this.points.addLayer(anchoredMarker(toLatLng(point), glyph, 'handles'));
    });
  }

  dispose(): void {
    this.shape.remove();
    this.points.remove();
    this.svg.remove();
  }
}
