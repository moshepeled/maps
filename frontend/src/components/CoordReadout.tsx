/**
 * The coordinate readout (UX C-27, SPEC section 8.1, section 8.6 R34): the pointer position - or the map centre while the pointer
 * is off the map, on touch and in keyboard drawing - in WGS84 (6 dp) and in the Israeli grid (ITM, metres, 1 dp, no
 * grouping), converted with the same proj4 definition as the ITM layer. Present in every build; never a live region.
 */
import { useStore } from 'zustand';

import { base } from '../base/en';
import { formatDegrees, formatItmMetres } from '../lib/format';
import { toItm } from '../map/itm';
import type { MapViewStoreApi } from '../state/mapViewStore';

export interface CoordReadoutProps {
  mapView: MapViewStoreApi;
  /**
   * `status`: the status bar (>= 600 px), the pointer or else the map centre; `list`: the phone Areas list, always
   * the map centre. Whenever it shows the centre, the line starts with "Map centre:" (UX C-27).
   */
  variant?: 'status' | 'list';
}

export function CoordReadout({ mapView, variant = 'status' }: CoordReadoutProps) {
  const pointer = useStore(mapView, (state) => (variant === 'status' ? state.pointer : null));
  const center = useStore(mapView, (state) => state.center);
  const position = pointer ?? center;
  // Leaflet reports continuous longitudes after panning across +/-180; wrap only then, so exact values stay exact.
  const lng =
    position.lng >= -180 && position.lng < 180
      ? position.lng
      : ((((position.lng + 180) % 360) + 360) % 360) - 180;
  const { e, n } = toItm(lng, position.lat);
  const text = base.coord.readout(
    formatDegrees(position.lat),
    formatDegrees(lng),
    formatItmMetres(e),
    formatItmMetres(n),
  );
  return (
    <p
      className={`coord-readout num coord-readout--${variant}`}
      data-testid="coord-readout"
      data-lat={position.lat}
      data-lng={lng}
      data-itm-e={e}
      data-itm-n={n}
      title={base.coord.help}
      dir="ltr"
    >
      {pointer === null ? <span className="coord-prefix">{base.coord.centreLabel} </span> : null}
      {text}
    </p>
  );
}
