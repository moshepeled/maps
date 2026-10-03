/**
 * Reshaping an existing area (UX F-04, C-12, F-10; SPEC section 8.6 "Editing"): the edit always starts from the
 * full-precision `AreaDto`, takes the advisory geometry lock (renewed every 10 s), streams the edit as a draft with
 * `areaId`, validates every point operation with the shared validator, and saves with `PATCH ... baseVersion`.
 * Conflicts and deletes are handed to the conflict flow.
 */
import type { AreaDto, AreaMutationResponse, Position, UserRef } from '@snapland/shared';

import { problemCurrent } from '../api/areas';
import { isApiError } from '../api/http';
import { TOAST_INFO_MS, TOAST_UNDO_MS } from '../constants/ux';
import { base } from '../base/en';
import { formatAreaSpoken } from '../lib/format';
import { displayName, displayUser } from '../lib/text';
import type { WriteHandle, WriteOutcome } from '../lib/writeRetry';
import { runWrite } from '../lib/writeRetry';
import type { DrawingLimits } from '../state/drawingReducer';
import type { EditRefusal, EditState } from '../state/editReducer';
import {
  closeRing,
  cycleSelection,
  deletePoint,
  edgeMidpoint,
  editMetrics,
  insertPoint,
  isDirty,
  movePoint,
  ringProblem,
  selectPoint,
  startEdit,
  undoEdit,
} from '../state/editReducer';
import { activeLock } from '../state/locksStore';
import { drawingLimits } from '../state/runtimeConfigStore';
import type { WorkspaceContext } from './context';
import { announce, awaitsSignIn, currentUser, showToast } from './context';
import type { LockKeeper, LockOutcome } from './lockKeeper';
import { geometryProblem } from './problems';

export interface EditFlowHooks {
  showSaved(area: AreaDto, viaKeyboard: boolean): void;
  mergedToast(
    area: AreaDto,
    theirs: readonly ('name' | 'description' | 'geometry')[],
    mine: readonly ('name' | 'description' | 'geometry')[],
  ): void;
  openShapeConflict(areaId: string, mine: Position[][], error: unknown): void;
  openDeletedWhileEditing(current: AreaDto): void;
  retryAfterSignIn(action: () => void): void;
}

const FIXED_REFUSAL_COPY: Record<Exclude<EditRefusal, 'max-points'>, { full: string; short: string }> = {
  'reverted-crossing': { full: base.edit.revertedCrossing, short: base.edit.revertedCrossingShort },
  'too-large': { full: base.edit.tooLarge, short: base.edit.tooLargeShort },
  'min-points': { full: base.edit.minPoints, short: base.edit.minPoints },
  'delete-would-cross': { full: base.edit.deleteWouldCross, short: base.edit.deleteWouldCrossShort },
};

/** The HUD / announcement copy of an edit refusal; the point limit comes from `GET /config` (SPEC section 8.6). */
export function refusalText(
  refusal: EditState['refusal'],
  limits: Pick<DrawingLimits, 'maxPoints'>,
): { full: string; short: string } | null {
  if (refusal === null) return null;
  if (refusal === 'max-points') {
    return { full: base.draw.maxPoints(limits.maxPoints), short: base.draw.maxPointsShort(limits.maxPoints) };
  }
  return FIXED_REFUSAL_COPY[refusal];
}

export class EditFlow {
  private saveHandle: WriteHandle<AreaMutationResponse> | null = null;
  private startRequest = 0;

  constructor(
    private readonly ctx: WorkspaceContext,
    private readonly locks: LockKeeper,
    private readonly hooks: EditFlowHooks,
  ) {}

  private get store() {
    return this.ctx.stores.edit;
  }

  private get workspace() {
    return this.ctx.stores.workspace;
  }

  private get limits() {
    return drawingLimits(this.ctx.stores.runtime.getState().config);
  }

  private get edit(): EditState | null {
    return this.store.getState().edit;
  }

  // -- entering (UX F-04 step 1, F-10 steps 2-4) --------------------------------------------

  /**
   * *Edit shape* / *Edit anyway* (`source: 'button'`) or `E` (`source: 'key'`). Areas with holes cannot be reshaped;
   * `E` on an area someone else is editing only focuses *Edit anyway* (the banner is the confirmation, SG-27).
   */
  start(source: 'button' | 'key'): void {
    const state = this.workspace.getState();
    const areaId = state.selectedAreaId;
    if (areaId === null || state.mode !== 'area-selected') return;
    const record = this.ctx.stores.areas.getState().byId.get(areaId);
    const detail =
      state.detail?.areaId === areaId && state.detail.status === 'ready' ? state.detail.area : null;
    if (record === undefined && detail === null) return;
    const rings = detail?.geometry.coordinates.length ?? record?.rings.length ?? 1;
    if (rings > 1) {
      announce(this.ctx, 'status', base.edit.holesDisabled);
      return;
    }
    const me = currentUser(this.ctx);
    const lock = activeLock(
      this.ctx.stores.locks.getState(),
      areaId,
      me?.id ?? null,
      this.ctx.scheduler.now(),
    );
    if (lock !== null && source === 'key') {
      state.requestFocus('edit-shape-button');
      announce(this.ctx, 'status', base.lock.editAnywayHint(lock.holder.displayName));
      return;
    }
    const knownHolder =
      lock === null ? null : { displayName: lock.holder.displayName, color: lock.holder.color };
    if (detail !== null && detail.version >= (record?.version ?? 0)) {
      this.begin(detail, null, knownHolder);
      return;
    }
    this.startRequest += 1;
    const request = this.startRequest;
    this.store.getState().patch({ loadingDetail: true });
    void this.ctx.api.areas
      .get(areaId)
      .then((area) => {
        if (request !== this.startRequest || this.workspace.getState().selectedAreaId !== areaId) return;
        this.workspace.getState().patch({ detail: { areaId, status: 'ready', area } });
        this.begin(area, null, knownHolder);
      })
      .catch(() => {
        showToast(this.ctx, {
          lane: 'own',
          kind: 'error',
          code: 'history.loadError',
          text: base.edit.loadingDetail,
          durationMs: TOAST_INFO_MS,
        });
      })
      .finally(() => {
        if (request === this.startRequest) this.store.getState().patch({ loadingDetail: false });
      });
  }

  /**
   * Starts editing `area` (full precision). `points` restores earlier work (Undo of a cancel, the restore banner,
   * "Take theirs" Undo, "Decide later"): the edit then continues on top of `area` as its base version.
   */
  begin(
    area: AreaDto,
    points: readonly Position[] | null,
    knownHolder: { displayName: string; color: string } | null,
  ): void {
    const exterior = area.geometry.coordinates[0] ?? [];
    let edit = startEdit({ areaId: area.id, name: area.name, version: area.version, exterior });
    if (points !== null) edit = { ...edit, points: [...points], undoStack: [edit.points] };
    this.store.getState().patch({
      edit,
      dragging: null,
      lock: knownHolder === null ? 'none' : 'both',
      lockHolder: knownHolder,
      newerVersion: null,
      otherEditor: null,
      saving: false,
      countdownUntil: null,
      serverInvalid: null,
      loadingDetail: false,
    });
    this.workspace.getState().patch({ mode: 'editing-shape', detailsEdit: null, sheet: 'peek' });
    announce(this.ctx, 'status', base.sr.editMode(area.name));
    this.ctx.map()?.focusMap();
    this.ctx.draft.open(area.id, { vertices: edit.points, cursor: null });
    void this.locks.acquire(area.id, 'geometry').then((outcome) => {
      this.applyLockOutcome(area.id, outcome, knownHolder);
    });
  }

  private applyLockOutcome(
    areaId: string,
    outcome: LockOutcome,
    knownHolder: { displayName: string; color: string } | null,
  ): void {
    if (this.edit?.areaId !== areaId) return;
    switch (outcome.kind) {
      case 'acquired':
        this.store.getState().patch({ lock: 'mine', lockHolder: null });
        return;
      case 'held':
        // The lock looked free but someone just took it: the race copy names the holder (UX F-10 step 6).
        this.store.getState().patch({
          lock: knownHolder === null ? 'race' : 'both',
          lockHolder: outcome.holder ?? knownHolder,
        });
        return;
      case 'unknown':
        this.store.getState().patch({ lock: 'unknown' });
        return;
      case 'limit':
        // Only reachable through stuck locks: continue without the lock and without a message (UX F-10 step 10).
        this.store.getState().patch({ lock: 'none' });
        return;
    }
  }

  // -- point operations (UX F-04 steps 4-7, C-12) -------------------------------------------

  private setEdit(next: EditState, announceRefusal = true): void {
    const previous = this.edit;
    this.store.getState().setEdit(next);
    if (announceRefusal && next.refusal !== null && next.refusal !== previous?.refusal) {
      const text = refusalText(next.refusal, this.limits);
      if (text !== null) announce(this.ctx, 'status', text.full);
    }
    this.stream(next.points, null);
  }

  select(index: number | null): void {
    const edit = this.edit;
    if (edit === null) return;
    const next = selectPoint(edit, index);
    this.store.getState().setEdit(next);
    if (next.selected !== null)
      announce(this.ctx, 'status', base.edit.pointSelected(next.selected + 1, next.points.length));
  }

  /** `]` / `[`: select the next / previous point and keep it visible (UX C-12, UX-AC-99). */
  cycle(direction: 1 | -1): void {
    const edit = this.edit;
    if (edit === null) return;
    const next = cycleSelection(edit, direction);
    this.store.getState().setEdit(next);
    const index = next.selected;
    if (index === null) return;
    const point = next.points[index];
    if (point !== undefined) this.ctx.map()?.ensureVisible(point);
    announce(this.ctx, 'status', base.edit.pointSelected(index + 1, next.points.length));
  }

  dragStart(index: number): void {
    const edit = this.edit;
    const point = edit?.points[index];
    if (edit === null || point === undefined) return;
    this.store.getState().patch({ dragging: { index, position: point, invalid: false } });
  }

  /** Live shape while dragging: invalid styling as soon as the move would make edges cross (UX C-12). */
  drag(index: number, position: Position): void {
    const edit = this.edit;
    if (edit === null) return;
    const points = edit.points.map((point, i) => (i === index ? position : point));
    const invalid = ringProblem(points, this.limits) !== null;
    this.store.getState().patch({ dragging: { index, position, invalid } });
    this.stream(points, position);
  }

  dragEnd(index: number, position: Position): void {
    const edit = this.edit;
    this.store.getState().patch({ dragging: null });
    if (edit === null) return;
    this.commitMove(edit, index, position);
  }

  private commitMove(edit: EditState, index: number, position: Position): void {
    const next = movePoint(edit, index, position, this.limits);
    this.setEdit(next);
    if (next.refusal === null) {
      announce(this.ctx, 'status', base.sr.pointMoved(formatAreaSpoken(editMetrics(next.points).areaKm2)));
    }
  }

  /** A midpoint click or drag inserts a point there (UX F-04 step 5). */
  insertAt(edgeIndex: number, position: Position): void {
    const edit = this.edit;
    if (edit === null) return;
    this.setEdit(insertPoint(edit, edgeIndex, position, this.limits));
  }

  /** `I`: insert a point at the midpoint of the edge after the selected one. */
  insertAfterSelected(): void {
    const edit = this.edit;
    if (edit?.selected === null || edit === null) return;
    const mid = edgeMidpoint(edit.points, edit.selected);
    if (mid !== null) this.insertAt(edit.selected, mid);
  }

  deletePoint(index: number): void {
    const edit = this.edit;
    if (edit === null) return;
    this.setEdit(deletePoint(edit, index, this.limits));
  }

  deleteSelected(): void {
    const selected = this.edit?.selected;
    if (selected !== null && selected !== undefined) this.deletePoint(selected);
  }

  /** *Move point* arms a click-to-place move of the selected point (WCAG 2.5.7 alternative, UX F-04 step 6). */
  toggleMove(): void {
    const edit = this.edit;
    if (edit?.selected === null || edit === null) return;
    this.store.getState().setEdit({ ...edit, moveArmed: !edit.moveArmed });
  }

  /** A map click while *Move point* is armed. */
  moveSelectedTo(position: Position): void {
    const edit = this.edit;
    if (edit?.moveArmed !== true || edit.selected === null) return;
    this.commitMove(edit, edit.selected, position);
  }

  /** Arrow keys with a point selected (UX C-12: 10 px, `Shift` 1 px). */
  nudge(dx: number, dy: number): void {
    const edit = this.edit;
    if (edit?.selected === null || edit === null) return;
    const point = edit.points[edit.selected];
    if (point === undefined) return;
    const target = this.ctx.map()?.offset(point, dx, dy);
    if (target === null || target === undefined) return;
    this.commitMove(edit, edit.selected, target);
    const moved = this.edit?.points[edit.selected];
    if (moved !== undefined) this.ctx.map()?.ensureVisible(moved);
  }

  undo(): void {
    const edit = this.edit;
    if (edit === null) return;
    this.setEdit(undoEdit(edit), false);
  }

  // -- leaving (UX F-04 steps 8-9) -----------------------------------------------------------

  /** `Esc`: the first press deselects a point (or stops *Move point*); the next one cancels the edit. */
  escape(): void {
    const edit = this.edit;
    if (edit === null) return;
    if (edit.moveArmed || edit.selected !== null) {
      this.store.getState().setEdit({ ...edit, moveArmed: false, selected: null, refusal: null });
      return;
    }
    this.cancel();
  }

  /** *Cancel*: silent without changes, else revert with an Undo toast that re-enters the edit (UX F-04 step 9). */
  cancel(): void {
    const edit = this.edit;
    if (edit === null) return;
    const original = this.baseArea(edit.areaId);
    const dirty = isDirty(edit);
    this.exit('cancelled');
    if (!dirty || original === null) return;
    const points = edit.points;
    showToast(this.ctx, {
      lane: 'own',
      kind: 'undo',
      code: 'toast.changesDiscarded',
      text: base.toast.changesDiscarded(displayName(edit.name)),
      durationMs: TOAST_UNDO_MS,
      action: {
        kind: 'undo',
        label: base.toast.undo,
        run: () => {
          const latest = this.baseArea(edit.areaId) ?? original;
          if (this.workspace.getState().selectedAreaId !== edit.areaId) return;
          if (this.workspace.getState().mode !== 'area-selected') return;
          this.begin(latest, points, null);
        },
      },
    });
  }

  private baseArea(areaId: string): AreaDto | null {
    const detail = this.workspace.getState().detail;
    return detail?.areaId === areaId && detail.status === 'ready' ? detail.area : null;
  }

  /** Ends the edit session: lock released, draft ended, back to AreaSelected (the panel stays). */
  exit(outcome: 'committed' | 'cancelled', committedAreaId: string | null = null): void {
    const edit = this.edit;
    if (edit === null) return;
    this.cancelSaveCountdown();
    this.locks.release(edit.areaId);
    this.ctx.draft.close(outcome, committedAreaId);
    this.store.getState().reset();
    if (
      this.workspace.getState().mode === 'editing-shape' ||
      this.workspace.getState().mode === 'saving-edit'
    ) {
      this.workspace.getState().patch({ mode: 'area-selected' });
    }
  }

  cancelSaveCountdown(): void {
    const handle = this.saveHandle;
    this.saveHandle = null;
    handle?.cancel();
  }

  /** *Save changes* / `Enter` / `Ctrl+S` (UX F-04 step 8). */
  save(viaKeyboard = false): void {
    const edit = this.edit;
    if (edit === null || !isDirty(edit) || this.store.getState().saving) return;
    if (ringProblem(edit.points, this.limits) !== null) return;
    const rings = [closeRing(edit.points)];
    this.workspace.getState().patch({ mode: 'saving-edit' });
    this.store.getState().patch({ saving: true, serverInvalid: null });
    this.ctx.stores.effects.getState().setPending(edit.areaId, true);
    const handle = runWrite(
      () =>
        this.ctx.api.areas.update(edit.areaId, {
          geometry: { type: 'Polygon', coordinates: rings },
          baseVersion: edit.baseVersion,
        }),
      {
        scheduler: this.ctx.scheduler,
        onCountdown: (until) => {
          this.store.getState().patch({ countdownUntil: until });
          this.ctx.clock.getState().tick();
        },
      },
    );
    this.saveHandle = handle;
    void handle.result.then((outcome) => {
      if (this.saveHandle === handle) this.saveHandle = null;
      this.ctx.stores.effects.getState().setPending(edit.areaId, false);
      this.onSaveOutcome(outcome, edit, rings, viaKeyboard);
    });
  }

  private backToEditing(): void {
    if (this.workspace.getState().mode === 'saving-edit')
      this.workspace.getState().patch({ mode: 'editing-shape' });
    this.store.getState().patch({ saving: false, countdownUntil: null });
  }

  private onSaveOutcome(
    outcome: WriteOutcome<AreaMutationResponse>,
    edit: EditState,
    rings: Position[][],
    viaKeyboard: boolean,
  ): void {
    if (outcome.ok) {
      const response = outcome.value;
      this.exit('committed', edit.areaId);
      this.hooks.showSaved(response.area, viaKeyboard);
      if (response.merged) {
        this.hooks.mergedToast(response.area, response.serverChangedFields, ['geometry']);
      } else {
        showToast(this.ctx, {
          lane: 'own',
          kind: 'info',
          code: 'toast.editSaved',
          text: base.toast.editSaved(displayName(response.area.name), response.area.version),
          durationMs: TOAST_INFO_MS,
        });
      }
      return;
    }
    this.backToEditing();
    if (outcome.cancelled) return;
    const error = outcome.error;
    if (awaitsSignIn(this.ctx, error)) {
      this.hooks.retryAfterSignIn(() => {
        this.save(viaKeyboard);
      });
      return;
    }
    if (isApiError(error, 'VERSION_CONFLICT')) {
      this.hooks.openShapeConflict(edit.areaId, rings, error);
      return;
    }
    if (isApiError(error, 'AREA_DELETED')) {
      const current = problemCurrent(error);
      if (current !== null) this.hooks.openDeletedWhileEditing(current);
      return;
    }
    if (isApiError(error, 'INVALID_GEOMETRY')) {
      const problem = geometryProblem(error);
      this.store
        .getState()
        .patch({ serverInvalid: { code: problem.code ?? 'generic', location: problem.location } });
      announce(this.ctx, 'alert', base.edit.serverInvalid(base.save.reason[problem.code ?? 'generic'] ?? ''));
      return;
    }
    if (isApiError(error, 'AREA_NOT_FOUND')) {
      this.exit('cancelled');
      showToast(this.ctx, {
        lane: 'own',
        kind: 'info',
        code: 'toast.areaGone',
        text: base.toast.areaGone,
        durationMs: TOAST_INFO_MS,
      });
      return;
    }
    const retry = (): void => {
      this.save(viaKeyboard);
    };
    const shown = displayName(edit.name);
    const [code, text, shortText] =
      outcome.reason === 'network'
        ? ['toast.saveFailedNetwork', base.toast.saveFailedNetwork(shown), base.toast.saveFailedNetworkShort]
        : outcome.reason === 'timeout'
          ? ['toast.saveTimeout', base.toast.saveTimeout(shown), base.toast.saveTimeoutShort]
          : ['toast.saveFailedServer', base.toast.saveFailedServer, base.toast.saveFailedServerShort];
    showToast(this.ctx, {
      lane: 'own',
      kind: 'error',
      code,
      text,
      shortText: this.ctx.isPhone() ? shortText : undefined,
      durationMs: null,
      action: { kind: 'retry', label: base.toast.retry, run: retry },
    });
  }

  // -- collaboration while editing (UX F-09 step 1, F-10 step 5) -----------------------------

  /** Someone saved a newer version of the area I am reshaping: early warning, nothing changes in my edit. */
  onRemoteVersion(area: AreaDto, actor: UserRef | null): void {
    const edit = this.edit;
    if (edit?.areaId !== area.id || area.version <= edit.baseVersion) return;
    this.store.getState().patch({ newerVersion: { user: actor, version: area.version } });
    const user = displayUser(actor?.displayName ?? base.collab.someone);
    announce(this.ctx, 'status', base.edit.newerVersion(user, area.version));
  }

  /** Streams the in-progress shape as a draft with `areaId` (UX F-04 step 4). */
  private stream(points: readonly Position[], cursor: Position | null): void {
    if (!this.ctx.draft.isOpen) return;
    this.ctx.draft.update({ vertices: points, cursor }, true);
  }

  dispose(): void {
    this.cancelSaveCountdown();
  }
}
