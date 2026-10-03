/**
 * Draw -> validate -> name -> save (UX F-03, C-06, C-09; SPEC section 8.6 "Drawing", section 7.12 steps 9-11). Geometry transitions
 * are the pure `drawingReducer`; this flow adds the mode machine, live streaming through the `DraftSession`, the
 * screen-reader announcements, the local safety net and the save with its retry policy.
 */
import type { AreaDto, AreaMutationResponse, Position } from '@snapland/shared';
import { codePointLength } from '@snapland/shared';

import { isApiError } from '../api/http';
import { DBLCLICK_ZOOM_REENABLE_MS, TOAST_INFO_MS, TOAST_UNDO_MS } from '../constants/ux';
import { base } from '../base/en';
import { formatArea, formatAreaSpoken } from '../lib/format';
import { displayName, sanitized } from '../lib/text';
import type { WriteHandle, WriteOutcome } from '../lib/writeRetry';
import { runWrite } from '../lib/writeRetry';
import { saveDraftAsArea } from '../realtime/draftSession';
import type { DrawingLimits, DrawingState } from '../state/drawingReducer';
import {
  addPoint,
  deriveDrawing,
  EMPTY_DRAWING,
  finish,
  restoreDrawing,
  setPointer,
  undoPoint,
} from '../state/drawingReducer';
import { EMPTY_NAMING } from '../state/drawingStore';
import { clearLocalDraft, markLocalDraftDiscarded } from '../state/localDraft';
import { descriptionMaxLength, drawingLimits, nameMaxLength } from '../state/runtimeConfigStore';
import type { WorkspaceContext } from './context';
import { announce, awaitsSignIn, currentUser, showToast } from './context';
import { drawingMessage } from './hudCopy';
import { fieldError, geometryProblem } from './problems';

export type InputSource = 'pointer' | 'touch' | 'keyboard';

export interface DrawingFlowHooks {
  /** A new area was created: select it and show its details (UX F-03 step 8). */
  onSaved(area: AreaDto, viaKeyboard: boolean): void;
  /** A request failed with 401 and the session dialog is up: retry it once after signing in again (UX F-11 step 4). */
  retryAfterSignIn(action: () => void): void;
}

function spokenArea(km2: number | null): string {
  return km2 === null ? base.sr.areaUnknown : formatAreaSpoken(km2);
}

/**
 * The area of the placed points alone, for the per-point announcements: the pointer (or the keyboard reticle) may sit
 * off the last point, and a provisional point would make the spoken area differ from what was placed (C-06.2, C-06.4).
 */
function placedAreaSpoken(state: DrawingState, limits: DrawingLimits): string {
  return spokenArea(deriveDrawing({ ...state, pointer: null }, limits).areaKm2);
}

function closeRing(points: readonly Position[]): Position[] {
  const first = points[0];
  return first === undefined ? [] : [...points, first];
}

export class DrawingFlow {
  private saveHandle: WriteHandle<AreaMutationResponse> | null = null;
  private storageToastId: string | null = null;
  private discardPurge: ReturnType<WorkspaceContext['scheduler']['setTimeout']> | null = null;

  constructor(
    private readonly ctx: WorkspaceContext,
    private readonly hooks: DrawingFlowHooks,
  ) {}

  private get limits() {
    return drawingLimits(this.ctx.stores.runtime.getState().config);
  }

  private get drawing() {
    return this.ctx.stores.drawing;
  }

  private get workspace() {
    return this.ctx.stores.workspace;
  }

  /** `D`, *Draw area* or phone *Draw* (UX F-03 step 1). Pressing it again while drawing cancels. */
  start(source: InputSource): void {
    const mode = this.workspace.getState().mode;
    if (mode === 'drawing') {
      this.cancel();
      return;
    }
    if (mode !== 'browse' && mode !== 'area-selected') {
      announce(this.ctx, 'status', base.draw.busy);
      return;
    }
    this.enterDrawing(EMPTY_DRAWING, source);
  }

  private enterDrawing(drawing: DrawingState, source: InputSource): void {
    this.cancelDiscardPurge();
    this.drawing.getState().patch({
      drawing,
      finishedRing: null,
      save: { kind: 'idle' },
      serverInvalid: null,
      viaKeyboard: source === 'keyboard',
    });
    this.workspace.getState().patch({
      mode: 'drawing',
      selectedAreaId: null,
      panel: this.workspace.getState().panel === 'list' ? 'list' : 'none',
      detail: null,
      history: null,
      preview: null,
      detailsEdit: null,
      hoverAreaId: null,
    });
    announce(this.ctx, 'status', base.sr.drawMode);
    this.ctx.map()?.focusMap();
  }

  /** Pointer / crosshair position (null when it leaves the map or on touch). Streams the rubber-band. */
  pointer(position: Position | null): void {
    if (this.workspace.getState().mode !== 'drawing') return;
    const store = this.drawing.getState();
    const next = setPointer(store.drawing, position);
    if (next === store.drawing) return;
    store.setDrawing(next);
    this.stream(false);
  }

  /** Places a point (click, tap or Space at the reticle). Returns what happened (the map uses it for the dblclick guard). */
  place(position: Position): 'added' | 'refused' | 'ignored' {
    if (this.workspace.getState().mode !== 'drawing') return 'ignored';
    const store = this.drawing.getState();
    const result = addPoint(store.drawing, position, this.limits);
    store.setDrawing(result.state);
    if (result.outcome === 'refused' && result.code !== null) {
      const reason = drawingMessage(result.code, {
        limits: this.limits,
        touch: false,
        keyboard: false,
        pointCount: 0,
      }).full;
      announce(this.ctx, 'status', base.sr.pointRefused(reason));
      return 'refused';
    }
    if (result.outcome === 'ignored') return 'ignored';
    const points = result.state.points;
    if (points.length === 1 && !this.ctx.draft.isOpen) {
      this.ctx.draft.open(null, { vertices: points, cursor: null });
    } else {
      this.stream(true);
    }
    const area = placedAreaSpoken(result.state, this.limits);
    announce(this.ctx, 'status', base.sr.pointAdded(points.length, area));
    return 'added';
  }

  /** `Backspace`, `Ctrl+Z`, *Undo point* (UX C-06.7). */
  undo(): void {
    const mode = this.workspace.getState().mode;
    if (mode !== 'drawing') return;
    const store = this.drawing.getState();
    if (store.drawing.points.length === 0) return;
    const next = undoPoint(store.drawing);
    store.setDrawing(next);
    this.stream(true);
    const area = placedAreaSpoken(next, this.limits);
    announce(this.ctx, 'status', base.sr.pointRemoved(next.points.length, area));
  }

  /** Any of the four finish methods (UX C-06.6): Naming on success, the refusal reason otherwise. */
  finish(): boolean {
    if (this.workspace.getState().mode !== 'drawing') return false;
    const store = this.drawing.getState();
    const result = finish(store.drawing, this.limits);
    store.setDrawing(result.state);
    if (!result.ok) {
      const reason = drawingMessage(result.code, {
        limits: this.limits,
        touch: false,
        keyboard: false,
        pointCount: store.drawing.points.length,
      }).full;
      announce(this.ctx, 'status', base.sr.finishRefused(reason));
      return false;
    }
    store.patch({ finishedRing: result.ring, save: { kind: 'idle' }, serverInvalid: null });
    this.workspace.getState().patch({ mode: 'naming', panel: 'save' });
    this.workspace.getState().requestFocus('name-input');
    // The ghost keeps the placed points only; the keepalive holds it while the user names it (SPEC section 7.12 step 11).
    this.ctx.draft.update({ vertices: result.state.points, cursor: null }, true);
    return true;
  }

  /** *Back to drawing* / `Esc` in the save form (UX F-03 step 6). */
  backToDrawing(): void {
    const mode = this.workspace.getState().mode;
    if (mode !== 'naming') return;
    this.cancelSaveCountdown();
    this.drawing.getState().patch({ finishedRing: null, save: { kind: 'idle' }, serverInvalid: null });
    this.workspace.getState().patch({ mode: 'drawing', panel: 'none' });
    this.ctx.map()?.focusMap();
  }

  /** `Esc` / *Cancel* / `D` while drawing, *Discard* while naming: exit with an Undo toast (UX F-03 step 10, C-06.8). */
  cancel(): void {
    const mode = this.workspace.getState().mode;
    if (mode !== 'drawing' && mode !== 'naming') return;
    this.cancelSaveCountdown();
    const snapshot = this.drawing.getState();
    const points = snapshot.drawing.points;
    const naming = snapshot.naming;
    this.ctx.draft.close('cancelled');
    this.drawing.getState().reset();
    this.workspace
      .getState()
      .patch({ mode: 'browse', panel: this.workspace.getState().panel === 'list' ? 'list' : 'none' });
    this.enableDoubleClickLater();
    if (points.length === 0) return;
    const user = currentUser(this.ctx);
    if (user !== null) {
      markLocalDraftDiscarded(user.id, this.ctx.scheduler.now());
      this.discardPurge = this.ctx.scheduler.setTimeout(() => {
        this.discardPurge = null;
        clearLocalDraft(user.id);
      }, TOAST_UNDO_MS);
    }
    showToast(this.ctx, {
      lane: 'own',
      kind: 'undo',
      code: 'toast.drawingDiscarded',
      text: base.toast.drawingDiscarded,
      durationMs: TOAST_UNDO_MS,
      action: {
        kind: 'undo',
        label: base.toast.undo,
        run: () => {
          this.undoCancel(points, naming);
        },
      },
    });
  }

  /** Undo of a cancel: the identical points and mode come back; streaming restarts with a new draft (UX C-06.8). */
  private undoCancel(points: readonly Position[], naming: typeof EMPTY_NAMING): void {
    const mode = this.workspace.getState().mode;
    if (mode !== 'browse' && mode !== 'area-selected') return;
    this.enterDrawing(restoreDrawing(points), 'pointer');
    this.drawing.getState().patch({ naming });
    this.ctx.draft.open(null, { vertices: this.drawing.getState().drawing.points, cursor: null });
  }

  /** The restore banner (UX C-24): back into Drawing or Naming with the saved points and form values. */
  restore(input: {
    kind: 'drawing' | 'naming';
    points: readonly Position[];
    name: string;
    description: string;
  }): void {
    this.enterDrawing(restoreDrawing(input.points), 'pointer');
    this.drawing.getState().patch({
      naming: {
        ...EMPTY_NAMING,
        name: input.name,
        description: input.description,
        descriptionOpen: input.description !== '',
      },
    });
    const points = this.drawing.getState().drawing.points;
    if (points.length > 0) this.ctx.draft.open(null, { vertices: points, cursor: null });
    this.ctx.map()?.fitPositions(points);
    if (input.kind === 'naming') this.finish();
  }

  /**
   * Naming with a prefilled shape and name, as a brand-new area (UX C-14 *Save a copy as a new area*). No live draft
   * is started: the copy gets a fresh id when it is saved.
   */
  startNamingWith(points: readonly Position[], name: string, description: string): void {
    const drawing = restoreDrawing(points);
    this.cancelDiscardPurge();
    this.drawing.getState().patch({
      drawing,
      finishedRing: closeRing(drawing.points),
      naming: { ...EMPTY_NAMING, name, description, descriptionOpen: description !== '' },
      save: { kind: 'idle' },
      serverInvalid: null,
      viaKeyboard: false,
    });
    this.workspace.getState().patch({
      mode: 'naming',
      panel: 'save',
      selectedAreaId: null,
      detail: null,
      history: null,
      preview: null,
    });
    this.workspace.getState().requestFocus('name-input');
    this.ctx.map()?.fitPositions(drawing.points);
  }

  // -- Save (UX F-03 steps 7-9, C-09) -------------------------------------------------------

  private validateForm(): { name: string; description: string | null } | null {
    const store = this.drawing.getState();
    const config = this.ctx.stores.runtime.getState().config;
    const name = sanitized(store.naming.name);
    const description = sanitized(store.naming.description, true);
    let nameError: string | null = null;
    let descriptionError: string | null = null;
    if (name === '') nameError = base.save.nameRequired;
    else if (codePointLength(name) > nameMaxLength(config))
      nameError = base.save.nameTooLong(nameMaxLength(config));
    if (codePointLength(description) > descriptionMaxLength(config)) {
      descriptionError = base.save.descriptionTooLong(descriptionMaxLength(config));
    }
    store.patchNaming({ nameError, descriptionError });
    if (nameError !== null || descriptionError !== null) {
      this.workspace.getState().requestFocus('name-input');
      return null;
    }
    return { name, description: description === '' ? null : description };
  }

  /** *Save area* / `Enter` in Name / `Ctrl+Enter` / `Ctrl+S`. */
  save(viaKeyboard = false): void {
    const mode = this.workspace.getState().mode;
    if (mode !== 'naming') return;
    const store = this.drawing.getState();
    if (store.save.kind === 'countdown' || store.save.kind === 'saving') return;
    const ring = store.finishedRing;
    if (ring === null) return;
    const form = this.validateForm();
    if (form === null) return;
    const body = {
      name: form.name,
      description: form.description,
      geometry: { type: 'Polygon' as const, coordinates: [ring] },
    };
    this.workspace.getState().patch({ mode: 'saving-new' });
    store.patch({ save: { kind: 'saving' }, serverInvalid: null });
    const pendingId = this.ctx.draft.draftId;
    if (pendingId !== null) this.ctx.stores.effects.getState().setPending(pendingId, true);
    const handle = runWrite(
      () =>
        saveDraftAsArea(
          this.ctx.draft,
          body,
          (request) => this.ctx.api.areas.create(request),
          () => this.ctx.newId(),
        ),
      {
        scheduler: this.ctx.scheduler,
        onCountdown: (until) => {
          this.drawing
            .getState()
            .patch({ save: until === null ? { kind: 'saving' } : { kind: 'countdown', until } });
          this.ctx.clock.getState().tick();
        },
        onStorageRetry: (active) => {
          this.storageToast(active);
        },
      },
    );
    this.saveHandle = handle;
    void handle.result.then((outcome) => {
      if (this.saveHandle === handle) this.saveHandle = null;
      if (pendingId !== null) this.ctx.stores.effects.getState().setPending(pendingId, false);
      this.onSaveOutcome(outcome, form.name, viaKeyboard);
    });
  }

  /** *Cancel* next to the "Saving in 23 s..." countdown: nothing is sent, the form stays (UX F-12 step 3). */
  cancelSaveCountdown(): void {
    const handle = this.saveHandle;
    if (handle === null) return;
    this.saveHandle = null;
    handle.cancel();
  }

  private storageToast(active: boolean): void {
    const toasts = this.ctx.stores.toasts.getState();
    if (active && this.storageToastId === null) {
      this.storageToastId = showToast(this.ctx, {
        lane: 'own',
        kind: 'info',
        code: 'toast.storageUnavailable',
        text: base.toast.storageUnavailable,
        durationMs: null,
      });
    } else if (!active && this.storageToastId !== null) {
      toasts.dismiss(this.storageToastId);
      this.storageToastId = null;
    }
  }

  private backToNaming(kind: 'idle' | 'failed'): void {
    if (this.workspace.getState().mode === 'saving-new') this.workspace.getState().patch({ mode: 'naming' });
    this.drawing.getState().patch({ save: { kind } });
  }

  private onSaveOutcome(
    outcome: WriteOutcome<AreaMutationResponse>,
    name: string,
    viaKeyboard: boolean,
  ): void {
    if (outcome.ok) {
      this.onSaved(outcome.value.area, viaKeyboard);
      return;
    }
    if (outcome.cancelled) {
      this.backToNaming('idle');
      return;
    }
    this.backToNaming('failed');
    const error = outcome.error;
    const retry = (): void => {
      this.save(viaKeyboard);
    };
    if (awaitsSignIn(this.ctx, error)) {
      this.hooks.retryAfterSignIn(retry);
      return;
    }
    if (isApiError(error, 'INVALID_GEOMETRY')) {
      const problem = geometryProblem(error);
      this.drawing
        .getState()
        .patch({ serverInvalid: { code: problem.code ?? 'generic', location: problem.location } });
      announce(this.ctx, 'alert', base.save.serverInvalid(base.save.reason[problem.code ?? 'generic'] ?? ''));
      return;
    }
    if (isApiError(error, 'VALIDATION_FAILED')) {
      const nameProblem = fieldError(error, 'name');
      const descriptionProblem = fieldError(error, 'description');
      if (nameProblem !== null || descriptionProblem !== null) {
        const config = this.ctx.stores.runtime.getState().config;
        this.drawing.getState().patchNaming({
          nameError:
            nameProblem === null
              ? null
              : name === ''
                ? base.save.nameRequired
                : base.save.nameTooLong(nameMaxLength(config)),
          descriptionError:
            descriptionProblem === null ? null : base.save.descriptionTooLong(descriptionMaxLength(config)),
        });
        this.workspace.getState().requestFocus('name-input');
        return;
      }
    }
    const shown = displayName(name);
    const phone = this.ctx.isPhone();
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
      shortText: phone ? shortText : undefined,
      durationMs: null,
      action: { kind: 'retry', label: base.toast.retry, run: retry },
    });
  }

  private onSaved(area: AreaDto, viaKeyboard: boolean): void {
    const user = currentUser(this.ctx);
    if (user !== null) clearLocalDraft(user.id);
    this.drawing.getState().reset();
    this.hooks.onSaved(area, viaKeyboard);
    showToast(this.ctx, {
      lane: 'own',
      kind: 'info',
      code: 'toast.saved',
      text: base.toast.saved(displayName(area.name), formatArea(area.areaKm2)),
      durationMs: TOAST_INFO_MS,
    });
  }

  // -- helpers -------------------------------------------------------------------------------

  /** Streams the draft: placed points plus the pointer (the rubber-band is part of "drawing in real time"). */
  private stream(pointsChanged: boolean): void {
    if (!this.ctx.draft.isOpen) return;
    const { drawing } = this.drawing.getState();
    this.ctx.draft.update({ vertices: drawing.points, cursor: drawing.pointer }, pointsChanged);
  }

  private cancelDiscardPurge(): void {
    this.ctx.scheduler.clearTimeout(this.discardPurge);
    this.discardPurge = null;
  }

  private enableDoubleClickLater(): void {
    this.workspace
      .getState()
      .patch({ dblClickZoomAfter: this.ctx.scheduler.now() + DBLCLICK_ZOOM_REENABLE_MS });
  }

  dispose(): void {
    this.cancelSaveCountdown();
    this.cancelDiscardPurge();
  }
}
