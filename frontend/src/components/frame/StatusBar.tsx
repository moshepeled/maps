/**
 * The status bar (UX C-29, v2; UI.md section 10.9), >= 600 px: the coordinate readout (C-27), the zoom level, a scale bar,
 * the viewport summary (C-26) and context key hints. A labelled group with no focusable element and no live region - * nothing in it is announced - whose text stays selectable. When space runs out, CSS drops the key hints, then the
 * scale bar, then the zoom; the readout and the summary are never dropped.
 */
import { useStore } from 'zustand';

import { useFinePointer, useWorkspace } from '../../app/AppContext';
import { base } from '../../base/en';
import { canDelete } from '../../state/selectors';
import { AnalysisSummary } from '../AreasList';
import { CoordReadout } from '../CoordReadout';
import { Icon } from '../Icon';
import { KeyHints } from './KeyHints';
import { statusHintContext, statusHints } from './hintRules';

/** A 1-2-5 scale bar of at most `maxPx` pixels (UI.md section 10.9). */
export function scaleFor(metersPerPixel: number, maxPx = 124): { label: string; px: number } {
  const maxMeters = metersPerPixel * maxPx;
  const magnitude = 10 ** Math.floor(Math.log10(maxMeters));
  const step =
    [5, 2, 1].map((factor) => factor * magnitude).find((candidate) => candidate <= maxMeters) ?? magnitude;
  const label = step >= 1000 ? `${step / 1000} km` : `${step} m`;
  return { label, px: Math.round(step / metersPerPixel) };
}

/** The zoom as the status bar shows it: at most one decimal, no trailing ".0" (`base.status.zoom`). */
export function zoomLabel(zoom: number): string {
  const rounded = Math.round(zoom * 10) / 10;
  return Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(1);
}

function ScaleBar() {
  const workspace = useWorkspace();
  const mpp = useStore(workspace.ctx.stores.mapView, (state) => state.metersPerPixel);
  if (mpp === null || !Number.isFinite(mpp) || mpp <= 0) return null;
  const { label, px } = scaleFor(mpp);
  return (
    <span className="scale-bar" data-testid="scale-bar" aria-hidden="true">
      <span className="scale-bar__line" style={{ width: `${px}px` }} />
      <span className="scale-bar__label num">{label}</span>
    </span>
  );
}

function StatusHints() {
  const workspace = useWorkspace();
  const stores = workspace.ctx.stores;
  const mode = useStore(stores.workspace, (state) => state.mode);
  const singleKeys = useStore(stores.workspace, (state) => state.singleKeyShortcuts);
  const areaId = useStore(stores.workspace, (state) => state.selectedAreaId);
  const viaKeyboard = useStore(stores.drawing, (state) => state.viaKeyboard);
  const pointSelected = useStore(stores.edit, (state) => state.edit !== null && state.edit.selected !== null);
  const record = useStore(stores.areas, (state) => (areaId === null ? undefined : state.byId.get(areaId)));
  const me = useStore(stores.auth, (state) => state.user);
  const fine = useFinePointer();
  if (!fine) return null;
  const context = statusHintContext(mode, viaKeyboard);
  // `Del` deletes only for the creator or an admin (UX C-11 permission variants), and only in AreaSelected.
  const deletable =
    mode === 'area-selected' &&
    record !== undefined &&
    canDelete(me, { createdById: record.createdById, createdBy: record.createdBy });
  const hints = statusHints(context, { singleKeys, canDelete: deletable, pointSelected });
  return (
    <KeyHints
      hints={hints}
      className="statusbar__hints"
      testId="status-key-hints"
      attributes={{ 'data-context': context }}
    />
  );
}

export function StatusBar() {
  const workspace = useWorkspace();
  const mapView = workspace.ctx.stores.mapView;
  const zoom = useStore(mapView, (state) => state.zoom);
  const mercatorZoom = useStore(mapView, (state) => state.mercatorZoom);
  const itm = useStore(mapView, (state) => state.displayedBaseLayer === 'govmap-itm');
  // `data-zoom` stays the map's own zoom (UX-AC-120). The text shows the Web-Mercator-equivalent level on the ITM
  // cache, whose level index (e.g. 7) would otherwise jump by ~8 on `L` for the same scale.
  const label = zoomLabel(zoom);
  const shown = itm ? zoomLabel(mercatorZoom) : label;
  return (
    <div className="statusbar" data-testid="status-bar" role="group" aria-label={base.status.label}>
      <span className="statusbar__cell statusbar__icon" aria-hidden="true">
        <Icon name="locate" size="sm" />
      </span>
      <span className="statusbar__cell statusbar__coords">
        <CoordReadout mapView={mapView} />
      </span>
      <span className="statusbar__cell statusbar__zoom num" data-testid="status-zoom" data-zoom={label}>
        {base.status.zoom(shown)}
      </span>
      <span className="statusbar__cell statusbar__scale">
        <ScaleBar />
      </span>
      <span className="statusbar__cell statusbar__summary">
        <AnalysisSummary variant="status" />
      </span>
      <span className="statusbar__spacer" />
      <StatusHints />
    </div>
  );
}
