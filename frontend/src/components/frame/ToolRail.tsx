/**
 * The tool rail (UX C-03, v2; UI.md section 10.5), >= 600 px: *Draw area*, *Edit shape*, a divider, *Areas in view*,
 * *People*, and *Shortcuts* at the bottom. Every tool is an extra entry point to an existing command (`D`, `E`, `A`,
 * `P`, `?`); each is its own tab stop, named by its label, with `aria-keyshortcuts` while single-key shortcuts are
 * on and a tooltip "{label}, {key}" on hover and keyboard focus (hoverable, `Esc` closes it; WCAG 1.4.13).
 */
import type { MouseEvent } from 'react';
import { useEffect, useId, useRef, useState } from 'react';
import { useStore } from 'zustand';

import { useLayout, useWorkspace } from '../../app/AppContext';
import { TOOLTIP_DELAY_MS } from '../../constants/ux';
import { base } from '../../base/en';
import { inspectorOpen } from '../../state/workspaceStore';
import type { IconName } from '../Icon';
import { Icon } from '../Icon';

interface RailButtonProps {
  testId: string;
  icon: IconName;
  label: string;
  keyChar: string;
  /** `aria-pressed` for the toggle tools; omitted for *People* and *Shortcuts*, which are not toggles. */
  pressed?: boolean;
  /** Why the tool is unavailable (`aria-disabled`, still focusable; the reason is its description and tooltip). */
  disabledReason?: string | null;
  popup?: 'dialog';
  onActivate: (event: MouseEvent<HTMLButtonElement>) => void;
}

/** `:focus-visible` (keyboard focus): only then does focus open the tooltip - a click must not leave one behind. */
function focusVisible(element: Element): boolean {
  try {
    return element.matches(':focus-visible');
  } catch {
    return true;
  }
}

function RailButton({
  testId,
  icon,
  label,
  keyChar,
  pressed,
  disabledReason = null,
  popup,
  onActivate,
}: RailButtonProps) {
  const workspace = useWorkspace();
  const singleKeys = useStore(workspace.ctx.stores.workspace, (state) => state.singleKeyShortcuts);
  const [tip, setTip] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const id = useId();
  const disabled = disabledReason !== null;
  const key = singleKeys ? keyChar : null;
  const clearTimer = (): void => {
    if (timer.current !== null) clearTimeout(timer.current);
    timer.current = null;
  };
  useEffect(() => clearTimer, []);
  return (
    <div
      className="rail-tool"
      onMouseEnter={() => {
        clearTimer();
        timer.current = setTimeout(() => {
          setTip(true);
        }, TOOLTIP_DELAY_MS);
      }}
      onMouseLeave={() => {
        clearTimer();
        setTip(false);
      }}
    >
      <button
        type="button"
        className="rail-btn"
        data-testid={testId}
        aria-label={label}
        aria-pressed={pressed}
        aria-disabled={disabled ? true : undefined}
        aria-describedby={disabled ? `${id}-reason` : undefined}
        aria-keyshortcuts={key ?? undefined}
        aria-haspopup={popup}
        onFocus={(event) => {
          if (focusVisible(event.currentTarget)) setTip(true);
        }}
        onBlur={() => {
          clearTimer();
          setTip(false);
        }}
        onKeyDown={(event) => {
          // Esc dismisses the tooltip without moving focus - and without also closing the layer below (UX section 8.1).
          if (event.key === 'Escape' && tip) {
            event.preventDefault();
            event.stopPropagation();
            setTip(false);
          }
        }}
        onClick={(event) => {
          setTip(false);
          if (!disabled) onActivate(event);
        }}
      >
        <Icon name={icon} size="lg" />
      </button>
      {disabled ? (
        <span id={`${id}-reason`} className="sr-only">
          {disabledReason}
        </span>
      ) : null}
      {tip ? (
        <span className="tooltip rail-tip" role="tooltip">
          <span className="rail-tip__label">
            {key === null ? label : `${label} · `}
            {key === null ? null : <kbd>{key}</kbd>}
          </span>
          {disabled ? <span className="rail-tip__reason">{disabledReason}</span> : null}
        </span>
      ) : null}
    </div>
  );
}

/** Why *Edit shape* is unavailable right now, or null when it works (it mirrors `edit-shape-button`). */
function useEditShapeAvailability(): { pressed: boolean; reason: string | null } {
  const workspace = useWorkspace();
  const stores = workspace.ctx.stores;
  const mode = useStore(stores.workspace, (state) => state.mode);
  const selectedAreaId = useStore(stores.workspace, (state) => state.selectedAreaId);
  const rings = useStore(stores.workspace, (state) =>
    state.detail?.areaId === state.selectedAreaId && state.detail.status === 'ready'
      ? state.detail.area.geometry.coordinates.length
      : null,
  );
  const recordRings = useStore(stores.areas, (state) =>
    selectedAreaId === null ? null : (state.byId.get(selectedAreaId)?.rings.length ?? null),
  );
  if (mode === 'editing-shape') return { pressed: true, reason: null };
  if (mode === 'saving-edit') return { pressed: true, reason: base.draw.busy };
  // Busy (drawing, naming, saving, ...) outranks "nothing selected": selecting would not help (UX-AC-116).
  if (mode !== 'browse' && mode !== 'area-selected') return { pressed: false, reason: base.draw.busy };
  if (selectedAreaId === null) return { pressed: false, reason: base.rail.editShapeUnavailable };
  if ((rings ?? recordRings ?? 1) > 1) return { pressed: false, reason: base.edit.holesDisabled };
  return { pressed: false, reason: null };
}

export function ToolRail() {
  const workspace = useWorkspace();
  const stores = workspace.ctx.stores;
  const mode = useStore(stores.workspace, (state) => state.mode);
  const panel = useStore(stores.workspace, (state) => state.panel);
  const extras = useStore(stores.workspace, (state) => state.inspectorExtras);
  const layout = useLayout();
  // Pressed while the list shows (C-03): the overlay inspector hides in Drawing / EditingShape, and the list with it.
  const listShown = panel === 'list' && inspectorOpen({ layout, mode, panel, inspectorExtras: extras });
  const editShape = useEditShapeAvailability();
  const drawBusy = mode !== 'browse' && mode !== 'area-selected' && mode !== 'drawing';
  return (
    <nav className="rail" data-testid="tool-rail" aria-label={base.rail.label}>
      <RailButton
        testId="draw-button"
        icon="snap-polygon-plus"
        label={base.draw.button}
        keyChar="D"
        pressed={mode === 'drawing'}
        disabledReason={drawBusy ? base.draw.busy : null}
        onActivate={(event) => {
          // Pressing it while drawing cancels (same as Esc); entering Drawing focuses the map (UX C-03).
          workspace.drawing.start(event.detail === 0 ? 'keyboard' : 'pointer');
        }}
      />
      <RailButton
        testId="rail-edit-button"
        icon="vector-square"
        label={base.edit.button}
        keyChar="E"
        pressed={editShape.pressed}
        disabledReason={editShape.reason}
        onActivate={() => {
          // Exactly what E does (F-04); again while editing = Cancel, with the Undo toast when there were changes.
          if (stores.workspace.getState().mode === 'editing-shape') workspace.edit.cancel();
          else workspace.edit.start('key');
        }}
      />
      <span className="rail-sep" aria-hidden="true" />
      <RailButton
        testId="areas-button"
        icon="list"
        label={base.rail.areas}
        keyChar="A"
        pressed={listShown}
        onActivate={(event) => {
          workspace.area.toggleList(event.detail === 0);
        }}
      />
      <RailButton
        testId="people-button"
        icon="users"
        label={base.rail.people}
        keyChar="P"
        onActivate={(event) => {
          workspace.showPeople(event.detail === 0);
        }}
      />
      <span className="rail-spacer" />
      <RailButton
        testId="shortcuts-button"
        icon="circle-help"
        label={base.rail.shortcuts}
        keyChar="?"
        popup="dialog"
        onActivate={() => {
          stores.workspace.getState().patch({ shortcutsOpen: true });
        }}
      />
    </nav>
  );
}
