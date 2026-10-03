/**
 * Base-map tone classes (UI.md section 2.5, section 9.1): each tile layer carries its own filter class, so the tint / dimming
 * never reaches the overlays, and an outgoing layer keeps its look during a cross-fade.
 */
import L from 'leaflet';
import { afterEach, describe, expect, it } from 'vitest';

import { createBaseLayer, IMAGERY_TILES_CLASS, OSM_TILES_CLASS } from './baseLayers';
import type { MapInstance } from './mapInstance';
import { createMapInstance } from './mapInstance';

const ignoreTiles = (): void => undefined;

let instance: MapInstance | null = null;

function mapOf(kind: 'mercator' | 'itm'): MapInstance {
  const host = document.createElement('div');
  document.body.append(host);
  instance = createMapInstance(host, kind, [32.085, 34.785], kind === 'itm' ? 6 : 15);
  return instance;
}

afterEach(() => {
  instance?.dispose();
  instance = null;
  document.body.replaceChildren();
});

describe('base-layer tone classes', () => {
  it('Map (OSM) tiles carry the OSM class, which the dark theme tints', () => {
    const { map, container } = mapOf('mercator');
    createBaseLayer('map', map, ignoreTiles).show(1);
    expect(container.querySelectorAll(`.leaflet-layer.${OSM_TILES_CLASS}`)).toHaveLength(1);
    expect(container.querySelectorAll(`.${IMAGERY_TILES_CLASS}`)).toHaveLength(0);
  });

  it('the Esri imagery of a kill-switch build is dimmed', () => {
    const { map, container } = mapOf('mercator');
    createBaseLayer('aerial', map, ignoreTiles).show(1);
    expect(container.querySelectorAll(`.leaflet-layer.${IMAGERY_TILES_CLASS}`)).toHaveLength(1);
    expect(container.querySelectorAll(`.${OSM_TILES_CLASS}`)).toHaveLength(0);
  });

  it('the GovMap 2022 ITM cache (Aerial) is imagery too', () => {
    const { map, container } = mapOf('itm');
    createBaseLayer('govmap-itm', map, ignoreTiles).show(1);
    expect(container.querySelectorAll(`.leaflet-layer.${IMAGERY_TILES_CLASS}`)).toHaveLength(1);
  });
});

describe('tile outcomes (UX section 7 tiles-failing notice)', () => {
  function tileImage(src: string): HTMLImageElement {
    const image = document.createElement('img');
    image.setAttribute('src', src);
    return image;
  }

  it('a failed tile counts once as an error: the load of its stand-in error tile is not a success', () => {
    const outcomes: boolean[] = [];
    const { map } = mapOf('mercator');
    createBaseLayer('map', map, (ok) => outcomes.push(ok)).show(1);
    const tileLayers: L.TileLayer[] = [];
    map.eachLayer((candidate) => {
      if (candidate instanceof L.TileLayer) tileLayers.push(candidate);
    });
    const [layer] = tileLayers;
    if (layer === undefined) throw new Error('the Map layer has no tile layer');
    const coords = L.point(1, 1) as L.Coords;
    coords.z = 15;
    layer.fire('tileerror', { tile: tileImage('https://tile.openstreetmap.org/15/1/1.png'), coords });
    layer.fire('tileload', { tile: tileImage(String(layer.options.errorTileUrl)), coords });
    layer.fire('tileload', { tile: tileImage('https://tile.openstreetmap.org/15/1/2.png'), coords });
    expect(outcomes).toEqual([false, true]);
  });
});
