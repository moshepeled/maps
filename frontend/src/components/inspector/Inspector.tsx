/**
 * The inspector (UX C-28, v2; UI.md section 10.8): the right-hand `aside` at >= 600 px. Docked (>= 1,200 px) it is a column
 * that is always there, so the map never resizes; as an overlay (600-1,199 px) it floats over the right of the map
 * only while it has content, hides in Drawing and EditingShape, and the map pans the shape out from under it.
 *
 * Sections, in order: the primary slot (Selection: area details, the Areas list, the save form, a conflict, or - * docked - the empty state), History, People and Activity.
 */
import { useEffect, useRef } from 'react';
import { useStore } from 'zustand';

import type { Bbox } from '@snapland/shared';
import { useLayout, useWorkspace } from '../../app/AppContext';
import { base } from '../../base/en';
import { inspectorOpen } from '../../state/workspaceStore';
import { AreaPanel } from '../AreaPanel';
import { AreasList } from '../AreasList';
import { ConflictPanel } from '../ConflictPanel';
import { Icon } from '../Icon';
import { SaveAreaForm } from '../SaveAreaForm';
import { ActivitySection } from './ActivitySection';
import { HistorySection } from './HistorySection';
import { PeopleSection } from './PeopleSection';

/** The primary slot's content (C-28): what the v1.2 side panel showed. */
export function PrimaryContent() {
  const workspace = useWorkspace();
  const panel = useStore(workspace.ctx.stores.workspace, (state) => state.panel);
  switch (panel) {
    case 'list':
      return <AreasList />;
    case 'save':
      return <SaveAreaForm />;
    case 'conflict':
      return <ConflictPanel />;
    case 'area':
      return <AreaPanel />;
    case 'none':
      return null;
  }
}

function SelectionEmpty() {
  return (
    <div className="selection-empty" data-testid="selection-empty">
      <div className="insp-head insp-head--primary">
        <span className="insp-kicker micro" aria-hidden="true">
          {base.inspector.selection}
        </span>
      </div>
      <p className="insp-empty">{base.inspector.selectionEmpty}</p>
    </div>
  );
}

function bboxOf(points: readonly (readonly [number, number])[]): Bbox | null {
  if (points.length === 0) return null;
  let [west, south] = points[0] ?? [0, 0];
  let [east, north] = [west, south];
  for (const [lng, lat] of points) {
    west = Math.min(west, lng);
    east = Math.max(east, lng);
    south = Math.min(south, lat);
    north = Math.max(north, lat);
  }
  return [west, south, east, north];
}

/**
 * Overlay only: when the inspector opens for a selection, the save form or a conflict and the shape lies under it,
 * the map pans the shape into the free map area (UX section 3.2). The map box itself never changes.
 */
function useRevealUnderOverlay(open: boolean, overlay: boolean): void {
  const workspace = useWorkspace();
  const stores = workspace.ctx.stores;
  const panel = useStore(stores.workspace, (state) => state.panel);
  const areaId = useStore(stores.workspace, (state) => state.selectedAreaId);
  useEffect(() => {
    if (!open || !overlay || panel === 'none' || panel === 'list') return undefined;
    const bbox =
      panel === 'save'
        ? bboxOf(stores.drawing.getState().drawing.points)
        : areaId === null
          ? null
          : (stores.areas.getState().byId.get(areaId)?.bbox ?? null);
    if (bbox === null) return undefined;
    // After the overlay is laid out: its width is what the map keeps clear (--map-inset-right).
    const frame = globalThis.requestAnimationFrame(() => {
      workspace.ctx.map()?.revealBbox(bbox);
    });
    return () => {
      globalThis.cancelAnimationFrame(frame);
    };
  }, [open, overlay, panel, areaId, stores, workspace]);
}

export function Inspector() {
  const workspace = useWorkspace();
  const stores = workspace.ctx.stores;
  const layout = useLayout();
  const panel = useStore(stores.workspace, (state) => state.panel);
  const mode = useStore(stores.workspace, (state) => state.mode);
  const extras = useStore(stores.workspace, (state) => state.inspectorExtras);
  const open = inspectorOpen({ layout, mode, panel, inspectorExtras: extras });
  const overlay = layout === 'overlay';
  const aside = useRef<HTMLElement>(null);
  const focusInside = useRef(false);
  /** Where focus came from into an overlay that holds only People / Activity: the rail, the presence button, the map. */
  const invoker = useRef<HTMLElement | null>(null);
  useRevealUnderOverlay(open, overlay);

  // An overlay that hides with focus inside hands focus to its invoker, else to the map, never to <body> (UX section 8.3,
  // C-28). The primary slot's content (area, list, save form, conflict) has its own focus rules, so only the
  // People / Activity overlay records an invoker.
  useEffect(() => {
    if (open || !focusInside.current) return;
    focusInside.current = false;
    const back = invoker.current;
    invoker.current = null;
    const active = document.activeElement;
    if (active !== null && active !== document.body && aside.current?.contains(active) !== true) return;
    if (back?.isConnected === true) back.focus({ preventScroll: true });
    else workspace.ctx.map()?.focusMap();
  }, [open, workspace]);

  return (
    <aside
      ref={aside}
      className="inspector"
      data-testid="inspector"
      data-layout={layout}
      data-open={open}
      aria-label={base.inspector.label}
      hidden={!open}
      onFocus={(event) => {
        if (!focusInside.current) {
          const from = event.relatedTarget;
          const extrasOnly = overlay && panel === 'none';
          invoker.current =
            extrasOnly && from instanceof HTMLElement && !event.currentTarget.contains(from) ? from : null;
        }
        focusInside.current = true;
      }}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) focusInside.current = false;
      }}
    >
      {overlay && panel === 'none' ? (
        <div className="insp-head insp-head--close">
          <span className="grow" />
          <button
            type="button"
            className="icon-btn"
            data-testid="inspector-close"
            aria-label={base.inspector.close}
            onClick={() => {
              workspace.closeInspectorExtras();
            }}
          >
            <Icon name="x" />
          </button>
        </div>
      ) : null}
      {!overlay || panel !== 'none' ? (
        <section className="insp-section insp-section--primary" data-testid="selection-section">
          {panel === 'none' ? <SelectionEmpty /> : <PrimaryContent />}
        </section>
      ) : null}
      <HistorySection variant="section" />
      <PeopleSection />
      <ActivitySection />
    </aside>
  );
}
