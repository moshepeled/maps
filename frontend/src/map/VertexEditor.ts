/**
 * Shape editing (UX F-04, C-12, UI.md section 9.6): my shape in the accent on its casing, a draggable point handle per point
 * (`point-handle`, 24 px hit / 44 on coarse pointers) and a midpoint handle per edge longer than 40 px (88 on coarse
 * pointers) on screen (`midpoint-handle`). Handles are diffed by index and never rebuilt during a drag, so Leaflet's
 * drag keeps working: only the two midpoints on the dragged point's edges slide along with it. The shape's paths are
 * kept too, and an invalid drag or a save only toggles their state classes.
 */
import type { Position } from '@snapland/shared';
import L from 'leaflet';

import { MIDPOINT_MIN_EDGE_PX, MIDPOINT_MIN_EDGE_TOUCH_PX } from '../constants/ux';
import { PANES } from './mapInstance';
import type { CasedPath } from './overlayUtil';
import { casedPath, fromLatLng, tagLayer, toLatLng, toLatLngs } from './overlayUtil';
import { elementIcon, groupElement } from './safe-dom';

export interface VertexEditorCallbacks {
  onSelect(index: number): void;
  onDragStart(index: number): void;
  onDrag(index: number, position: Position): void;
  onDragEnd(index: number, position: Position): void;
  onMidpointActivate(edgeIndex: number, position: Position): void;
  onDeleteRequest(index: number): void;
}

export interface VertexEditorInput {
  points: readonly Position[];
  selected: number | null;
  /** *Move point* is armed for the selected point (the next map click moves it). */
  moveArmed: boolean;
  /** The point being dragged and its live position (the shape follows it). */
  dragging: { index: number; position: Position; invalid: boolean } | null;
  saving: boolean;
  coarse: boolean;
}

function middle(a: Position, b: Position): Position {
  return [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
}

function handleElement(testId: string, index: number, selected: boolean, armed: boolean): HTMLElement {
  const classes = ['snap-handle'];
  if (testId === 'midpoint-handle') classes.push('snap-handle--mid');
  if (selected) classes.push('is-selected');
  if (armed) classes.push('is-armed');
  return groupElement('div', [groupElement('span', [], { class: 'snap-handle__dot' })], {
    class: classes.join(' '),
    'data-testid': testId,
    'data-index': index,
    'data-selected': selected ? 'true' : 'false',
  });
}

export class VertexEditor {
  private readonly svg: L.SVG;
  /** Outline, casing and core of the shape (UI.md section 9.2); the outline only shows while a drag is invalid. */
  private shape: CasedPath | null = null;
  private handles: L.Marker[] = [];
  /** Keyed by edge index: edge i runs from point i to point i + 1 (short edges have no midpoint). */
  private readonly midpoints = new Map<number, L.Marker>();
  private active = false;
  private handleKey = '';

  constructor(
    private readonly map: L.Map,
    private readonly callbacks: VertexEditorCallbacks,
  ) {
    this.svg = L.svg({ pane: PANES.own.name });
  }

  sync(input: VertexEditorInput | null): void {
    if (input === null) {
      this.clear();
      return;
    }
    const points = input.points.map((point, index) =>
      input.dragging?.index === index ? input.dragging.position : point,
    );
    this.syncShape(points, input);
    if (input.dragging !== null) {
      // Rebuilding handles would end Leaflet's gesture, so only the midpoints next to the dragged point move.
      this.moveMidpoints(points, input.dragging.index);
      return;
    }
    const key = JSON.stringify([
      input.points,
      input.selected,
      input.moveArmed,
      input.coarse,
      this.map.getZoom(),
      input.saving,
    ]);
    if (key === this.handleKey && this.active) return;
    this.handleKey = key;
    this.rebuildHandles(input);
    this.active = true;
  }

  private syncShape(points: readonly Position[], input: VertexEditorInput): void {
    if (this.shape === null) {
      this.shape = casedPath(toLatLngs(points), {
        renderer: this.svg,
        role: 'ov-own ov-edit',
        closed: true,
        fill: true,
        outline: true,
      });
      for (const layer of this.shape.layers) layer.addTo(this.map);
    } else {
      for (const layer of this.shape.layers) layer.setLatLngs(toLatLngs(points));
    }
    for (const layer of this.shape.layers) {
      const element = layer.getElement();
      element?.classList.toggle('is-invalid', input.dragging?.invalid === true);
      element?.classList.toggle('is-saving', input.saving);
    }
    tagLayer(this.shape.core, {
      'data-testid': 'own-draft',
      'data-points': points.length,
      'data-state': 'editing',
    });
  }

  private moveMidpoints(points: readonly Position[], index: number): void {
    const count = points.length;
    for (const edge of [(index - 1 + count) % count, index]) {
      const from = points[edge];
      const to = points[(edge + 1) % count];
      const marker = this.midpoints.get(edge);
      if (marker !== undefined && from !== undefined && to !== undefined)
        marker.setLatLng(toLatLng(middle(from, to)));
    }
  }

  private removeHandles(): void {
    for (const marker of [...this.handles, ...this.midpoints.values()]) marker.remove();
    this.handles = [];
    this.midpoints.clear();
  }

  private rebuildHandles(input: VertexEditorInput): void {
    this.removeHandles();
    if (input.saving) return;
    const minEdge = input.coarse ? MIDPOINT_MIN_EDGE_TOUCH_PX : MIDPOINT_MIN_EDGE_PX;
    const size = input.coarse ? 44 : 24;
    input.points.forEach((point, index) => {
      const next = input.points[(index + 1) % input.points.length];
      if (next === undefined) return;
      const a = this.map.latLngToContainerPoint(toLatLng(point));
      const b = this.map.latLngToContainerPoint(toLatLng(next));
      if (a.distanceTo(b) < minEdge) return;
      const mid = middle(point, next);
      const marker = L.marker(toLatLng(mid), {
        icon: elementIcon(handleElement('midpoint-handle', index, false, false), {
          className: 'snap-handle-icon',
          iconSize: [size, size],
          iconAnchor: [size / 2, size / 2],
        }),
        draggable: true,
        keyboard: false,
        pane: PANES.handles.name,
        zIndexOffset: 0,
      });
      marker.on('click', () => {
        this.callbacks.onMidpointActivate(index, mid);
      });
      marker.on('dragend', () => {
        this.callbacks.onMidpointActivate(index, fromLatLng(marker.getLatLng()));
      });
      marker.addTo(this.map);
      this.midpoints.set(index, marker);
    });
    input.points.forEach((point, index) => {
      const selected = input.selected === index;
      const marker = L.marker(toLatLng(point), {
        icon: elementIcon(handleElement('point-handle', index, selected, selected && input.moveArmed), {
          className: 'snap-handle-icon',
          iconSize: [size, size],
          iconAnchor: [size / 2, size / 2],
        }),
        draggable: true,
        keyboard: false,
        pane: PANES.handles.name,
        zIndexOffset: 1000,
      });
      marker.on('click', () => {
        this.callbacks.onSelect(index);
      });
      marker.on('contextmenu', (event) => {
        L.DomEvent.preventDefault(event.originalEvent);
        this.callbacks.onDeleteRequest(index);
      });
      marker.on('dragstart', () => {
        this.callbacks.onDragStart(index);
      });
      marker.on('drag', () => {
        this.callbacks.onDrag(index, fromLatLng(marker.getLatLng()));
      });
      marker.on('dragend', () => {
        this.callbacks.onDragEnd(index, fromLatLng(marker.getLatLng()));
      });
      marker.addTo(this.map);
      this.handles.push(marker);
    });
  }

  private clear(): void {
    for (const layer of this.shape?.layers ?? []) layer.remove();
    this.shape = null;
    this.removeHandles();
    this.active = false;
    this.handleKey = '';
  }

  dispose(): void {
    this.clear();
    this.svg.remove();
  }
}
