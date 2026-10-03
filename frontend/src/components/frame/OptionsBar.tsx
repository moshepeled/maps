/**
 * The options bar (UX C-05 v2; UI.md section 10.6): the docked HUD above the map at >= 600 px. It is present in every mode
 * with a constant height, so the map never resizes on a mode change (UX-AC-115/117); only its content changes
 * (`data-content`). A labelled group - never a live region, never a roving toolbar - whose controls keep the HUD's tab
 * order. Key hints are text (`aria-hidden`), shown only with a fine pointer.
 */
import { useStore } from 'zustand';

import { useFinePointer, useWorkspace } from '../../app/AppContext';
import { base } from '../../base/en';
import { formatAreaParts } from '../../lib/format';
import { displayName } from '../../lib/text';
import { activeLock } from '../../state/locksStore';
import type { Mode } from '../../state/workspaceStore';
import { DrawHud, EditHud, ModeTag, PreviewLegend } from '../Hud';
import { KeyHints } from './KeyHints';
import { browseHints, selectedHints } from './hintRules';

/** `options-bar[data-content]` (UX section 12). */
export type OptionsBarContent = 'browse' | 'drawing' | 'naming' | 'editing' | 'preview' | 'selected';

export function optionsBarContent(mode: Mode, editing: boolean): OptionsBarContent {
  switch (mode) {
    case 'browse':
      return 'browse';
    case 'drawing':
      return 'drawing';
    case 'naming':
    case 'saving-new':
      return 'naming';
    case 'editing-shape':
    case 'saving-edit':
      return 'editing';
    case 'resolving-conflict':
      // A shape conflict keeps the edit on screen; a rename conflict is about the selected area.
      return editing ? 'editing' : 'selected';
    case 'previewing-version':
      return 'preview';
    case 'area-selected':
      return 'selected';
  }
}

const GROUP_LABEL: Record<OptionsBarContent, string> = {
  browse: base.optbar.label,
  drawing: base.optbar.tagDraw,
  naming: base.optbar.tagDraw,
  editing: base.edit.button,
  preview: base.optbar.tagPreview,
  selected: base.optbar.tagSelected,
};

function BrowseContent() {
  const workspace = useWorkspace();
  const singleKeys = useStore(workspace.ctx.stores.workspace, (state) => state.singleKeyShortcuts);
  const fine = useFinePointer();
  if (!fine) return null;
  return <KeyHints hints={browseHints(singleKeys)} className="optbar-hints" testId="optbar-key-hints" />;
}

/** AreaSelected: the neutral tag, the name and area, and the key hints; the actions live in the Selection section. */
function SelectedContent() {
  const workspace = useWorkspace();
  const stores = workspace.ctx.stores;
  const areaId = useStore(stores.workspace, (state) => state.selectedAreaId);
  const detail = useStore(stores.workspace, (state) => state.detail);
  const mode = useStore(stores.workspace, (state) => state.mode);
  const singleKeys = useStore(stores.workspace, (state) => state.singleKeyShortcuts);
  const record = useStore(stores.areas, (state) => (areaId === null ? undefined : state.byId.get(areaId)));
  const locks = useStore(stores.locks, (state) => state);
  const meId = useStore(stores.auth, (state) => state.user?.id ?? null);
  const loadingEdit = useStore(stores.edit, (state) => state.loadingDetail);
  const now = useStore(workspace.ctx.clock, (state) => state.now);
  const fine = useFinePointer();
  const full = detail?.areaId === areaId && detail.status === 'ready' ? detail.area : null;
  const name = full?.name ?? record?.name ?? '';
  const km2 = full?.areaKm2 ?? record?.areaKm2 ?? null;
  const holes = (full?.geometry.coordinates.length ?? record?.rings.length ?? 1) > 1;
  const locked = areaId !== null && activeLock(locks, areaId, meId, now) !== null;
  const hints = selectedHints({ singleKeys, lockedByOther: locked, holes });
  const parts = km2 === null ? null : formatAreaParts(km2);
  return (
    <>
      <ModeTag icon="square-mouse-pointer" text={base.optbar.tagSelected} tone="neutral" variant="bar" />
      <span className="optbar-sep" aria-hidden="true" />
      <span className="optbar-name" title={name}>
        <bdi>{displayName(name)}</bdi>
        {parts === null ? null : (
          <span className="optbar-name__area">
            <span className="num">{parts.value}</span> {parts.unit}
          </span>
        )}
      </span>
      {loadingEdit ? (
        <span className="optbar-status" role="status">
          <span className="spinner xs" aria-hidden="true" />
          {base.optbar.loadingDetail}
        </span>
      ) : null}
      {fine && mode === 'area-selected' ? (
        <>
          <span className="optbar-sep" aria-hidden="true" />
          <span className="optbar-hints-group" data-testid="optbar-key-hints" aria-hidden="true">
            <KeyHints hints={hints.main} className="optbar-hints" />
            <span className="grow" />
            <KeyHints hints={hints.trailing} className="optbar-hints" />
          </span>
        </>
      ) : null}
    </>
  );
}

export function OptionsBar() {
  const workspace = useWorkspace();
  const mode = useStore(workspace.ctx.stores.workspace, (state) => state.mode);
  const editing = useStore(workspace.ctx.stores.edit, (state) => state.edit !== null);
  const content = optionsBarContent(mode, editing);
  return (
    <div
      className="optbar"
      data-testid="options-bar"
      data-content={content}
      role="group"
      aria-label={GROUP_LABEL[content]}
    >
      {content === 'browse' ? <BrowseContent /> : null}
      {content === 'selected' ? <SelectedContent /> : null}
      {content === 'drawing' || content === 'naming' ? <DrawHud variant="bar" /> : null}
      {content === 'editing' ? <EditHud variant="bar" /> : null}
      {content === 'preview' ? <PreviewLegend variant="bar" /> : null}
    </div>
  );
}

/** Whether the phone HUD row is docked above the map (the frame sizes its grid row from this). */
export function phoneHudShown(mode: Mode, editing: boolean): boolean {
  return (
    mode === 'drawing' ||
    ((mode === 'editing-shape' || mode === 'saving-edit') && editing) ||
    mode === 'previewing-version'
  );
}

/**
 * The phone HUD (UX section 3.2, C-05; UI.md section 10.13): docked between the title bar and the map in Drawing, EditingShape and
 * PreviewingVersion, hidden otherwise (and in phone Naming). Its appearance shrinks the map from the top; the map
 * keeps its content in place on screen (`mapInstance.ts`).
 */
export function PhoneHud() {
  const workspace = useWorkspace();
  const mode = useStore(workspace.ctx.stores.workspace, (state) => state.mode);
  const editing = useStore(workspace.ctx.stores.edit, (state) => state.edit !== null);
  if (!phoneHudShown(mode, editing)) return null;
  const label =
    mode === 'drawing'
      ? base.optbar.tagDraw
      : mode === 'previewing-version'
        ? base.optbar.tagPreview
        : base.edit.button;
  return (
    <div className="phone-hud" role="group" aria-label={label}>
      {mode === 'drawing' ? <DrawHud variant="phone" /> : null}
      {mode === 'editing-shape' || mode === 'saving-edit' ? <EditHud variant="phone" /> : null}
      {mode === 'previewing-version' ? <PreviewLegend variant="phone" /> : null}
    </div>
  );
}
