/**
 * One Leaflet map in the stacked map host (SPEC section 8.4 cross-CRS switch): a Web Mercator map for *Map* / *Aerial*, or
 * an EPSG:2039 map for the GovMap 2022 cache. Leaflet's own chrome is off (zoom, attribution, keyboard) because the
 * app renders those itself once for all stacked maps; panes follow UI.md section 7 so overlays stack identically on both.
 */
import L from 'leaflet';

import { CLICK_TOLERANCE_PX, MAP_MAX_ZOOM, MAP_MIN_ZOOM, TAP_TOLERANCE_PX } from '../constants/ux';
import { createItmCrs, ITM_MAX_ZOOM, ITM_MIN_ZOOM } from './itmLayer';

export type CrsKind = 'mercator' | 'itm';

/**
 * Overlay panes (UI.md section 7; z-indices mirror tokens.css `--z-pane-*`). Collaborators' point dots get a pane of their
 * own above their lines: Leaflet gives each marker a z-index from its latitude, which can be negative, so a dot that
 * shared a pane with an SVG layer could slip under the line it marks.
 */
export const PANES = {
  pulse: { name: 'snap-pulse', z: 390 },
  locks: { name: 'snap-locks', z: 395 },
  areas: { name: 'snap-areas', z: 400 },
  selection: { name: 'snap-selection', z: 405 },
  history: { name: 'snap-history', z: 410 },
  remote: { name: 'snap-remote', z: 420 },
  remotePoints: { name: 'snap-remote-points', z: 425 },
  own: { name: 'snap-own', z: 430 },
  handles: { name: 'snap-handles', z: 610 },
  chips: { name: 'snap-chips', z: 640 },
} as const;

export type PaneKey = keyof typeof PANES;

/**
 * UX C-04: a pointer movement up to CLICK_TOLERANCE_PX (mouse) / TAP_TOLERANCE_PX (touch) is still a click, not a pan.
 * Leaflet reads the tolerance from `Draggable.prototype.options` (its typings omit that static options object).
 */
function setClickTolerance(px: number): void {
  const prototype = L.Draggable.prototype as unknown as { options: { clickTolerance: number } };
  prototype.options.clickTolerance = px;
}

function coarsePointer(): boolean {
  return typeof globalThis.matchMedia === 'function' && globalThis.matchMedia('(pointer: coarse)').matches;
}

export interface MapInstance {
  kind: CrsKind;
  map: L.Map;
  container: HTMLDivElement;
  dispose(): void;
}

export function createMapInstance(
  host: HTMLElement,
  kind: CrsKind,
  center: L.LatLngExpression,
  zoom: number,
): MapInstance {
  setClickTolerance(coarsePointer() ? TAP_TOLERANCE_PX : CLICK_TOLERANCE_PX);
  const container = document.createElement('div');
  container.className = `snap-map-instance snap-map-instance--${kind}`;
  host.append(container);
  const map = L.map(container, {
    crs: kind === 'itm' ? createItmCrs() : L.CRS.EPSG3857,
    center,
    zoom,
    minZoom: kind === 'itm' ? ITM_MIN_ZOOM : MAP_MIN_ZOOM,
    maxZoom: kind === 'itm' ? ITM_MAX_ZOOM : MAP_MAX_ZOOM,
    zoomControl: false,
    attributionControl: false,
    keyboard: false,
    doubleClickZoom: false,
    boxZoom: false,
    worldCopyJump: kind === 'mercator',
    zoomSnap: 1,
    wheelPxPerZoomLevel: 90,
  });
  for (const pane of Object.values(PANES)) {
    const element = map.getPane(pane.name) ?? map.createPane(pane.name);
    element.style.zIndex = String(pane.z);
  }
  // Remote drafts, chips, pulses and selection copies never take clicks (UX section 3.3).
  for (const key of ['pulse', 'locks', 'selection', 'history', 'remote', 'remotePoints', 'chips'] as const) {
    const element = map.getPane(PANES[key].name);
    if (element !== undefined) element.style.pointerEvents = 'none';
  }
  let origin = container.getBoundingClientRect();
  const resize = new ResizeObserver(() => {
    // ResizeObserver also reports the unchanged size right after observe(). `invalidateSize` would then drop
    // Leaflet's exact centre for one derived from the rounded pixel origin, drifting the reported centre by up to half
    // a pixel (~1e-5° at z16) and breaking the Map <-> Aerial centre rule (UX-AC-45: +/-1e-6°). Only real resizes count.
    const size = map.getSize();
    if (container.clientWidth === size.x && container.clientHeight === size.y) return;
    const next = container.getBoundingClientRect();
    // `pan: false` keeps the top-left corner's position; when that corner itself moved on screen (the phone HUD
    // docking above the map, UX section 3.2), pan by the same amount so the map content stays where it was (UX-AC-122).
    map.invalidateSize({ pan: false });
    const dx = next.left - origin.left;
    const dy = next.top - origin.top;
    origin = next;
    if (dx !== 0 || dy !== 0) map.panBy([dx, dy], { animate: false });
  });
  resize.observe(host);
  return {
    kind,
    map,
    container,
    dispose: () => {
      resize.disconnect();
      map.remove();
      container.remove();
    },
  };
}
