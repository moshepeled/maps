/**
 * The phone bottom bar (UX section 3.2, C-03, C-06.10, C-12; UI.md section 10.13), below 600 px, in the tool rail's place in the
 * tab order: *Draw area*, *Areas* in Browse / AreaSelected; `Cancel --- Undo, Finish` while drawing;
 * `Cancel --- Undo, Save` while reshaping. It shares the rail's test ids, and only one of the two is rendered.
 */
import type { MouseEvent } from 'react';
import { useStore } from 'zustand';

import { useWorkspace } from '../../app/AppContext';
import { base } from '../../base/en';
import { formatCountdown } from '../../lib/format';
import { deriveDrawing } from '../../state/drawingReducer';
import { isDirty, ringProblem } from '../../state/editReducer';
import { drawingLimits } from '../../state/runtimeConfigStore';
import type { Mode } from '../../state/workspaceStore';
import { Icon } from '../Icon';

/** Whether the phone bottom bar is shown (the frame sizes its grid row from this). */
export function bottomBarShown(mode: Mode, editing: boolean): boolean {
  return (
    mode === 'browse' ||
    mode === 'area-selected' ||
    mode === 'drawing' ||
    ((mode === 'editing-shape' || mode === 'saving-edit') && editing)
  );
}

export function BottomBar() {
  const workspace = useWorkspace();
  const stores = workspace.ctx.stores;
  const mode = useStore(stores.workspace, (state) => state.mode);
  const panel = useStore(stores.workspace, (state) => state.panel);
  const drawingState = useStore(stores.drawing, (state) => state.drawing);
  const edit = useStore(stores.edit, (state) => state.edit);
  const saving = useStore(stores.edit, (state) => state.saving);
  const countdownUntil = useStore(stores.edit, (state) => state.countdownUntil);
  const config = useStore(stores.runtime, (state) => state.config);
  const now = useStore(workspace.ctx.clock, (state) => state.now);
  const focusMap = (event: MouseEvent): void => {
    if (event.detail > 0) workspace.ctx.map()?.focusMap();
  };
  if (mode === 'drawing') {
    const view = deriveDrawing(drawingState, drawingLimits(config));
    return (
      <nav className="bottombar" data-testid="bottom-bar" aria-label={base.draw.button}>
        <button
          type="button"
          className="btn btn-xl btn-secondary"
          data-testid="cancel-draw-button"
          onClick={() => {
            workspace.drawing.cancel();
          }}
        >
          {base.draw.cancel}
        </button>
        <span className="grow" />
        <button
          type="button"
          className="btn btn-xl btn-secondary"
          data-testid="undo-point-button"
          aria-label={base.draw.undoPointLabel}
          aria-disabled={drawingState.points.length === 0}
          onClick={(event) => {
            workspace.drawing.undo();
            focusMap(event);
          }}
        >
          <Icon name="undo-2" size="lg" />
          {base.draw.undo}
        </button>
        <button
          type="button"
          className="btn btn-xl btn-primary bottombar__primary"
          data-testid="finish-button"
          aria-disabled={!view.canFinish}
          onClick={(event) => {
            workspace.drawing.finish();
            if (stores.workspace.getState().mode === 'drawing') focusMap(event);
          }}
        >
          <Icon name="check" size="lg" />
          {base.draw.finish}
        </button>
      </nav>
    );
  }
  if ((mode === 'editing-shape' || mode === 'saving-edit') && edit !== null) {
    const dirty = isDirty(edit);
    const invalid = ringProblem(edit.points, drawingLimits(config)) !== null;
    return (
      <nav className="bottombar" data-testid="bottom-bar" aria-label={base.edit.title(edit.name)}>
        <button
          type="button"
          className="btn btn-xl btn-secondary"
          data-testid="cancel-edit-button"
          onClick={() => {
            workspace.edit.cancel();
          }}
        >
          {base.edit.cancel}
        </button>
        <span className="grow" />
        <button
          type="button"
          className="btn btn-xl btn-secondary"
          data-testid="undo-edit-button"
          aria-disabled={edit.undoStack.length === 0}
          onClick={(event) => {
            workspace.edit.undo();
            focusMap(event);
          }}
        >
          <Icon name="undo-2" size="lg" />
          {base.edit.undo}
        </button>
        <button
          type="button"
          className="btn btn-xl btn-primary bottombar__primary"
          data-testid="save-edit-button"
          aria-label={base.edit.save}
          aria-disabled={!dirty || invalid || saving}
          onClick={(event) => {
            workspace.edit.save(event.detail === 0);
          }}
        >
          <Icon name="check" size="lg" />
          {countdownUntil !== null
            ? base.rate.saveButton(formatCountdown(countdownUntil - now))
            : base.edit.saveShort}
        </button>
      </nav>
    );
  }
  if (mode !== 'browse' && mode !== 'area-selected') return null;
  return (
    <nav className="bottombar bottombar--split" data-testid="bottom-bar" aria-label={base.rail.label}>
      <button
        type="button"
        className="btn btn-xl btn-secondary"
        data-testid="draw-button"
        aria-pressed={false}
        onClick={() => {
          workspace.drawing.start('touch');
        }}
      >
        <Icon name="snap-polygon-plus" size="lg" />
        {base.draw.button}
      </button>
      <button
        type="button"
        className="btn btn-xl btn-secondary"
        data-testid="areas-button"
        aria-pressed={panel === 'list'}
        onClick={() => {
          workspace.area.toggleList(false);
        }}
      >
        <Icon name="list" size="lg" />
        Areas
      </button>
    </nav>
  );
}
