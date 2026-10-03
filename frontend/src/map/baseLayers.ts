/**
 * Base layers (SPEC section 8.3; user decisions D-1, D-7) and their `FadeLayer` adapter for the cross-fade:
 * - `map`: OpenStreetMap;
 * - `govmap-itm`: *Aerial*, the GovMap 2022 ITM cache (EPSG:2039, `itmLayer.ts`), on its own map instance;
 * - `aerial`: Esri World Imagery, what *Aerial* shows in a build with the ITM kill switch off (`VITE_ENABLE_ITM_LAYER`).
 * The Mercator layers support zoom 3-21 through `maxNativeZoom`, so a same-CRS switch never changes the zoom.
 * Each tile layer carries its tone class (UI.md section 2.5, section 9.1): `snap-tiles--osm` (tinted in the dark theme) or
 * `snap-tiles--imagery` (dimmed about 26 %). The filter sits on the layer, not the tile pane, so overlays are never
 * filtered and an outgoing layer keeps its own look during a cross-fade.
 */
import L from 'leaflet';

import type { BaseLayerId } from '../state/mapViewStore';
import type { FadeLayer } from './crossfade';
import { GovmapItmTileLayer } from './itmLayer';

const EMPTY_TILE = 'data:image/gif;base64,R0lGODlhAQABAAAAACH5BAEKAAEALAAAAAABAAEAAAICTAEAOw==';
const OSM_URL = 'https://tile.openstreetmap.org/{z}/{x}/{y}.png';
const ESRI_URL =
  'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}';
export const OSM_TILES_CLASS = 'snap-tiles--osm';
export const IMAGERY_TILES_CLASS = 'snap-tiles--imagery';

export interface BaseLayerHandle extends FadeLayer {
  id: BaseLayerId;
}

let zIndexCounter = 1;

/** Adapts one tile layer to the cross-fade. */
class TileLayerFade implements BaseLayerHandle {
  private loaded = false;
  private added = false;
  private listeners = new Set<() => void>();

  constructor(
    readonly id: BaseLayerId,
    private readonly map: L.Map,
    private readonly layer: L.TileLayer,
  ) {
    layer.on('loading', () => {
      this.loaded = false;
    });
    layer.on('load', () => {
      this.loaded = true;
      if (this.isLoaded()) for (const listener of [...this.listeners]) listener();
    });
  }

  show(opacity: number): void {
    zIndexCounter += 1;
    this.layer.setOpacity(opacity);
    this.layer.setZIndex(zIndexCounter);
    if (!this.map.hasLayer(this.layer)) this.layer.addTo(this.map);
    this.added = true;
  }

  setOpacity(opacity: number): void {
    this.layer.setOpacity(opacity);
  }

  bringToFront(): void {
    zIndexCounter += 1;
    this.layer.setZIndex(zIndexCounter);
  }

  remove(): void {
    if (this.map.hasLayer(this.layer)) this.map.removeLayer(this.layer);
    this.loaded = false;
    this.added = false;
  }

  onLoad(callback: () => void): () => void {
    this.listeners.add(callback);
    return () => {
      this.listeners.delete(callback);
    };
  }

  isLoaded(): boolean {
    return this.added && this.loaded;
  }
}

function createTileLayer(id: BaseLayerId): L.TileLayer {
  if (id === 'govmap-itm') return new GovmapItmTileLayer(IMAGERY_TILES_CLASS);
  const osm = id === 'map';
  return L.tileLayer(osm ? OSM_URL : ESRI_URL, {
    maxNativeZoom: 19,
    maxZoom: 21,
    errorTileUrl: EMPTY_TILE,
    className: osm ? OSM_TILES_CLASS : IMAGERY_TILES_CLASS,
  });
}

/**
 * Builds base layer `id` for a map instance of the matching CRS; `onTile` receives every tile outcome (true = loaded)
 * for the tiles-failing notice (UX section 7).
 */
export function createBaseLayer(id: BaseLayerId, map: L.Map, onTile: (ok: boolean) => void): BaseLayerHandle {
  const layer = createTileLayer(id);
  layer.on('tileload', (event) => {
    // Leaflet swaps a failed tile for `errorTileUrl` and reports that image's load as a `tileload`. Counting it would
    // pair every error with a success, so the tiles-failing notice could never trip.
    if (event.tile.getAttribute('src') !== EMPTY_TILE) onTile(true);
  });
  layer.on('tileerror', () => {
    onTile(false);
  });
  return new TileLayerFade(id, map, layer);
}
