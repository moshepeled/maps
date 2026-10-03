/**
 * The map view (SPEC section 8.4, UX section 7): which base map the user chose, which layer that resolves to, and the current
 * centre/zoom/viewport. Geometry never lives here - overlays are views of the other stores.
 */
import type { Bbox } from '@snapland/shared';
import { createStore } from 'zustand/vanilla';

import { DEFAULT_VIEW } from '../constants/ux';

/** `map[data-base-layer]` / E2E hook values (SPEC section 0). */
export type BaseLayerId = 'map' | 'aerial' | 'govmap-itm';
/** What the user picked in the switcher. */
export type LayerChoice = 'map' | 'aerial';

/**
 * *Aerial* is the GovMap 2022 ITM cache (`govmap-itm`, user decision D-1), or Esri World Imagery (`aerial`) in a build
 * whose `VITE_ENABLE_ITM_LAYER` kill switch is off (SPEC section 8.3).
 */
export function resolveBaseLayer(choice: LayerChoice, itmLayerEnabled: boolean): BaseLayerId {
  if (choice === 'map') return 'map';
  return itmLayerEnabled ? 'govmap-itm' : 'aerial';
}

/** `L` toggles Map <-> Aerial (UX section 8.1). */
export function toggledChoice(choice: LayerChoice): LayerChoice {
  return choice === 'map' ? 'aerial' : 'map';
}

export interface LatLng {
  lat: number;
  lng: number;
}

export interface MapViewState {
  choice: LayerChoice;
  baseLayer: BaseLayerId;
  center: LatLng;
  /** The zoom of the current map (a Web Mercator zoom, or an ITM level while `govmap-itm` is shown). */
  zoom: number;
  /** Web Mercator zoom equivalent (for bbox requests and LOD), whatever the CRS. */
  mercatorZoom: number;
  /** Visible viewport, normalised; null before the map is ready. */
  viewport: Bbox | null;
  /** Pointer (mouse/pen over the map) for the coordinate readout; null -> the map centre is shown. */
  pointer: LatLng | null;
  /**
   * The base layer that is visually on top: it swaps at the cross-fade's midpoint (`map[data-base-layer]`, overlay
   * styling, attribution - UI.md section 8), while `baseLayer` / the switcher change immediately on selection.
   */
  displayedBaseLayer: BaseLayerId;
  /** Ground metres per CSS pixel at the map centre (scale bar). */
  metersPerPixel: number | null;
}

export interface MapViewStore extends MapViewState {
  setChoice(choice: LayerChoice, baseLayer: BaseLayerId): void;
  setView(view: { center: LatLng; zoom: number; mercatorZoom: number; viewport: Bbox }): void;
  setPointer(pointer: LatLng | null): void;
  setDisplayed(layer: BaseLayerId): void;
  setMetersPerPixel(metersPerPixel: number | null): void;
}

export function createMapViewStore(initial?: Partial<MapViewState>) {
  return createStore<MapViewStore>()((set) => ({
    choice: 'map',
    baseLayer: 'map',
    center: { ...DEFAULT_VIEW.center },
    zoom: DEFAULT_VIEW.zoom,
    mercatorZoom: DEFAULT_VIEW.zoom,
    viewport: null,
    pointer: null,
    displayedBaseLayer: initial?.baseLayer ?? 'map',
    metersPerPixel: null,
    ...initial,
    setChoice: (choice, baseLayer) => {
      set({ choice, baseLayer });
    },
    setView: (view) => {
      set(view);
    },
    setPointer: (pointer) => {
      set({ pointer });
    },
    setDisplayed: (layer) => {
      set({ displayedBaseLayer: layer });
    },
    setMetersPerPixel: (metersPerPixel) => {
      set({ metersPerPixel });
    },
  }));
}

export type MapViewStoreApi = ReturnType<typeof createMapViewStore>;
