/**
 * Leaflet side of the GovMap 2022 ITM cache (SPEC section 8.3, section 8.4, user decision D-1): the EPSG:2039 CRS built with
 * proj4leaflet from the shared definition in `itm.ts`, and a tile layer whose `getTileUrl` produces the cache's
 * `L{LL}/R{row:08x}/C{col:08x}` paths - those are not Leaflet template tokens, hence the subclass.
 */
import L from 'leaflet';
import 'proj4leaflet';

import {
  EPSG_2039,
  ITM_BOUNDS,
  ITM_MAX_LEVEL,
  ITM_MAX_NATIVE_LEVEL,
  ITM_ORIGIN,
  ITM_PROJ4,
  ITM_RESOLUTIONS,
  itmTileUrl,
} from './itm';

const EMPTY_TILE = 'data:image/gif;base64,R0lGODlhAQABAAAAACH5BAEKAAEALAAAAAABAAEAAAICTAEAOw==';

export function createItmCrs(): L.Proj.CRS {
  return new L.Proj.CRS(EPSG_2039, ITM_PROJ4, {
    origin: [ITM_ORIGIN[0], ITM_ORIGIN[1]],
    resolutions: [...ITM_RESOLUTIONS],
    bounds: L.bounds([ITM_BOUNDS[0], ITM_BOUNDS[1]], [ITM_BOUNDS[2], ITM_BOUNDS[3]]),
  });
}

export class GovmapItmTileLayer extends L.TileLayer {
  /** `className` is the tile tone class (baseLayers.ts): the cache is imagery. */
  constructor(className: string) {
    super('', {
      minZoom: 0,
      maxZoom: ITM_MAX_LEVEL,
      maxNativeZoom: ITM_MAX_NATIVE_LEVEL,
      errorTileUrl: EMPTY_TILE,
      // The cache is served without CORS headers; tiles are plain <img>s, so no crossOrigin attribute.
      keepBuffer: 2,
      className,
    });
  }

  override getTileUrl(coords: L.Coords): string {
    return itmTileUrl(coords.z, coords.x, coords.y);
  }
}

export const ITM_MIN_ZOOM = 0;
export const ITM_MAX_ZOOM = ITM_MAX_LEVEL;
