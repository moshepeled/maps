/**
 * The phone bottom sheet (UX section 3.2, C-11; UI.md section 10.13), below 600 px: the inspector's primary slot and History.
 * Snaps: `peek` for a selection, `expanded` on request (and for the Areas list), `conflict` at 50 dvh and a
 * content-sized `naming` sheet. It covers the bottom bar and is hidden while a shape is being reshaped. Expand and
 * Close are buttons: dragging is never required (WCAG 2.5.7).
 */
import { useLayoutEffect, useRef } from 'react';
import { useStore } from 'zustand';

import { useWorkspace } from '../../app/AppContext';
import { base } from '../../base/en';
import { Icon } from '../Icon';
import { HistorySection } from './HistorySection';
import { PrimaryContent } from './Inspector';

export function AreaSheet() {
  const workspace = useWorkspace();
  const stores = workspace.ctx.stores;
  const panel = useStore(stores.workspace, (state) => state.panel);
  const mode = useStore(stores.workspace, (state) => state.mode);
  const sheet = useStore(stores.workspace, (state) => state.sheet);
  const selectedAreaId = useStore(stores.workspace, (state) => state.selectedAreaId);
  const body = useRef<HTMLDivElement>(null);
  // New content or a new snap starts at its top: the header row, not wherever the previous content was scrolled to
  // (after a delete the list came back scrolled past its title and close button).
  useLayoutEffect(() => {
    if (body.current !== null) body.current.scrollTop = 0;
  }, [panel, sheet, selectedAreaId]);
  if (panel === 'none') return null;
  if (mode === 'editing-shape' || mode === 'saving-edit') return null;
  const snap = panel === 'save' ? 'naming' : panel === 'conflict' ? 'conflict' : sheet;
  const expanded = sheet === 'expanded';
  const label =
    panel === 'list' ? base.list.heading : panel === 'save' ? base.save.title : base.inspector.selectedArea;
  return (
    <section className={`sheet sheet--${snap}`} data-testid="area-sheet" data-snap={snap} aria-label={label}>
      {snap === 'naming' || snap === 'conflict' ? null : (
        <div className="sheet-head">
          <span className="sheet-handle" aria-hidden="true" />
          {panel === 'area' ? (
            <span className="insp-kicker micro" aria-hidden="true">
              {base.inspector.selectedArea}
            </span>
          ) : null}
          <span className="grow" />
          <button
            type="button"
            className="icon-btn"
            data-testid="sheet-expand-button"
            aria-expanded={expanded}
            aria-label={expanded ? base.common.collapse : base.common.expand}
            onClick={() => {
              stores.workspace.getState().patch({ sheet: expanded ? 'peek' : 'expanded' });
            }}
          >
            <Icon name={expanded ? 'chevron-down' : 'chevron-up'} size="lg" />
          </button>
          {panel === 'area' ? (
            <button
              type="button"
              className="icon-btn"
              data-testid="sheet-close-button"
              aria-label={base.panel.close}
              onClick={() => {
                workspace.area.close();
              }}
            >
              <Icon name="x" size="lg" />
            </button>
          ) : null}
        </div>
      )}
      <div ref={body} className="sheet-body">
        <PrimaryContent />
        <HistorySection variant="sheet" />
      </div>
    </section>
  );
}
