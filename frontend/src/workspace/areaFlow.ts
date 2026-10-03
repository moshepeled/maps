/**
 * Everything about one selected area that is not reshaping (UX F-05 ... F-07, C-10, C-11, C-13, C-14): selection and
 * the full detail load (404 -> tombstone -> gone), rename and description with their soft lock, delete with Undo (and
 * its 409 / 403 / countdown paths), restore, history, version preview and "Restore this version".
 */
import type { AreaDto, AreaMutationResponse, AreaVersionDto, Position } from '@snapland/shared';
import { codePointLength } from '@snapland/shared';

import { problemCurrent } from '../api/areas';
import { isApiError } from '../api/http';
import { DBLCLICK_ZOOM_REENABLE_MS, TOAST_INFO_MS, TOAST_UNDO_MS } from '../constants/ux';
import { base, fieldList } from '../base/en';
import { formatCountdown } from '../lib/format';
import { displayName, displayUser, sanitized } from '../lib/text';
import type { WriteOutcome } from '../lib/writeRetry';
import { retryDelayMs, runWrite } from '../lib/writeRetry';
import { applyChange, removeArea } from '../state/areasStore';
import { descriptionMaxLength, nameMaxLength } from '../state/runtimeConfigStore';
import { canDelete, listedAreas } from '../state/selectors';
import type { DetailsEditState } from '../state/workspaceStore';
import { sectionExpanded } from '../state/workspaceStore';
import type { WorkspaceContext } from './context';
import { announce, awaitsSignIn, currentUser, showToast } from './context';
import type { LockKeeper } from './lockKeeper';
import { fieldError } from './problems';

export type SelectVia = 'map' | 'list' | 'keyboard';

export interface AreaFlowHooks {
  /** The latest known actor of an area (for merge toasts, UX F-09 step 2). */
  lastActor(areaId: string): { displayName: string } | null;
  /** Opens the conflict panel for a rename / description save (UX F-09 step 3). */
  openDetailsConflict(
    areaId: string,
    mine: { name?: string; description?: string | null },
    error: unknown,
  ): void;
  /** *Save a copy as a new area* (UX C-14). */
  saveCopy(points: readonly Position[], name: string, description: string): void;
  retryAfterSignIn(action: () => void): void;
}

const FALLBACK_READ_RETRY_MS = 5000;

export class AreaFlow {
  private detailRequest = 0;
  private historyRequest = 0;
  private renameHandle: { cancel(): void } | null = null;

  constructor(
    private readonly ctx: WorkspaceContext,
    private readonly locks: LockKeeper,
    private readonly hooks: AreaFlowHooks,
  ) {}

  private get workspace() {
    return this.ctx.stores.workspace;
  }

  private record(areaId: string) {
    return this.ctx.stores.areas.getState().byId.get(areaId) ?? null;
  }

  /** The detail DTO if it is loaded and not older than the store's copy. */
  private readyDetail(areaId: string): AreaDto | null {
    const detail = this.workspace.getState().detail;
    if (detail?.areaId !== areaId || (detail.status !== 'ready' && detail.status !== 'deleted')) return null;
    return detail.area;
  }

  /** The newest version this client knows of an area (its detail or its store record). */
  private currentVersion(areaId: string): number {
    return Math.max(this.readyDetail(areaId)?.version ?? 0, this.record(areaId)?.version ?? 0);
  }

  // -- selection (UX section 3.4, C-11) -------------------------------------------------------------

  select(areaId: string, via: SelectVia): void {
    const state = this.workspace.getState();
    if (state.mode !== 'browse' && state.mode !== 'area-selected') return;
    if (state.selectedAreaId === areaId && state.panel === 'area') {
      if (via !== 'map') state.requestFocus('panel-heading');
      return;
    }
    this.closeDetailsEdit();
    state.patch({
      mode: 'area-selected',
      selectedAreaId: areaId,
      panel: 'area',
      panelInvoker: via,
      detail: { areaId, status: 'loading' },
      history: null,
      preview: null,
      unsavedText: null,
      sheet: 'peek',
    });
    if (via !== 'map') state.requestFocus('panel-heading');
    void this.loadDetail(areaId);
    this.loadHistoryIfShown(areaId);
  }

  /** Shows a freshly saved or restored area as selected with its server values (UX F-03 step 8). */
  showSaved(area: AreaDto, viaKeyboard: boolean): void {
    this.applyArea(area, 'update');
    this.workspace.getState().patch({
      mode: 'area-selected',
      selectedAreaId: area.id,
      panel: 'area',
      panelInvoker: viaKeyboard ? 'keyboard' : 'map',
      detail: { areaId: area.id, status: 'ready', area },
      history: null,
      preview: null,
      detailsEdit: null,
      dblClickZoomAfter: this.ctx.scheduler.now() + DBLCLICK_ZOOM_REENABLE_MS,
    });
    if (viaKeyboard) this.workspace.getState().requestFocus('panel-heading');
    this.loadHistoryIfShown(area.id);
  }

  async loadDetail(areaId: string): Promise<void> {
    this.detailRequest += 1;
    const request = this.detailRequest;
    const stillWanted = (): boolean =>
      request === this.detailRequest && this.workspace.getState().selectedAreaId === areaId;
    try {
      const area = await this.ctx.api.areas.get(areaId);
      if (!stillWanted()) return;
      // A live event can overtake the request: a newer version or the delete already shown must stay (C-14).
      const shown = this.readyDetail(areaId);
      if (shown !== null && shown.version >= area.version) return;
      const tombstone = this.ctx.stores.areas.getState().tombstones.get(areaId);
      if (tombstone !== undefined && tombstone.version >= area.version) {
        await this.loadTombstone(areaId, stillWanted);
        return;
      }
      this.applyArea(area, 'update');
      this.workspace.getState().patch({ detail: { areaId, status: 'ready', area } });
    } catch (error) {
      if (!stillWanted()) return;
      if (isApiError(error, 'AREA_NOT_FOUND')) {
        await this.loadTombstone(areaId, stillWanted);
        return;
      }
      if (isApiError(error) && error.status === 429) {
        const retryAt = this.ctx.scheduler.now() + retryDelayMs(error, FALLBACK_READ_RETRY_MS);
        this.workspace.getState().patch({ detail: { areaId, status: 'rate-limited', retryAt } });
        this.ctx.scheduler.setTimeout(() => {
          if (stillWanted()) void this.loadDetail(areaId);
        }, retryAt - this.ctx.scheduler.now());
        return;
      }
      this.workspace.getState().patch({ detail: { areaId, status: 'error' } });
    }
  }

  /** UX C-11 "not found": a soft-deleted area shows the deleted state; a purged one disappears with a toast. */
  private async loadTombstone(areaId: string, stillWanted: () => boolean): Promise<void> {
    try {
      const area = await this.ctx.api.areas.get(areaId, { includeDeleted: true });
      if (!stillWanted()) return;
      this.applyArea(area, 'delete');
      this.workspace.getState().patch({ detail: { areaId, status: 'deleted', area } });
    } catch (error) {
      if (!stillWanted()) return;
      if (isApiError(error, 'AREA_NOT_FOUND')) {
        this.ctx.stores.areas
          .getState()
          .update((state) => removeArea(state, areaId, this.ctx.scheduler.now()));
        this.close();
        showToast(this.ctx, {
          lane: 'own',
          kind: 'info',
          code: 'toast.areaGone',
          text: base.toast.areaGone,
          durationMs: TOAST_INFO_MS,
        });
        return;
      }
      this.workspace.getState().patch({ detail: { areaId, status: 'error' } });
    }
  }

  /** x / `Esc` / click on empty map: focus returns to the invoker (UX section 8.3). */
  close(): void {
    const state = this.workspace.getState();
    const areaId = state.selectedAreaId;
    this.closeDetailsEdit();
    state.patch({
      mode: 'browse',
      selectedAreaId: null,
      panel: state.panel === 'list' ? 'list' : 'none',
      detail: null,
      history: null,
      preview: null,
      unsavedText: null,
      dblClickZoomAfter: this.ctx.scheduler.now() + DBLCLICK_ZOOM_REENABLE_MS,
    });
    if (state.panelInvoker === 'list' && areaId !== null) {
      // Back in the list: on phones it is only usable expanded (as `toggleList` opens it). At peek height the list
      // item that takes focus scrolls the list's own title and close button out of the sheet.
      state.patch({ panel: 'list', sheet: 'expanded' });
      state.requestFocus('list-item', areaId);
    } else if (state.panelInvoker !== 'map') {
      state.requestFocus('map');
    }
  }

  /** *Areas* / `A`: the list replaces the area panel; pressing it again closes the list (UX C-03). */
  toggleList(focusList: boolean): void {
    const state = this.workspace.getState();
    if (state.panel === 'list') {
      state.patch({ panel: state.selectedAreaId !== null ? 'area' : 'none' });
      return;
    }
    if (state.mode !== 'browse' && state.mode !== 'area-selected' && state.mode !== 'drawing') return;
    // On phones the list is only usable expanded; the desktop panel ignores the sheet height.
    state.patch({ panel: 'list', sheet: 'expanded' });
    if (focusList) state.requestFocus('list-item');
  }

  /** *Back to list* from an area opened from the list (UX C-10). */
  backToList(): void {
    const state = this.workspace.getState();
    const areaId = state.selectedAreaId;
    this.close();
    state.patch({ panel: 'list', sheet: 'expanded' });
    if (areaId !== null) state.requestFocus('list-item', areaId);
  }

  zoomTo(): void {
    const areaId = this.workspace.getState().selectedAreaId;
    const area = areaId === null ? null : this.record(areaId);
    if (area !== null) this.ctx.map()?.flyToBbox(area.bbox);
  }

  // -- rename / description (UX F-05) --------------------------------------------------------

  startDetailsEdit(field: 'name' | 'description', initialText?: string): void {
    const state = this.workspace.getState();
    const areaId = state.selectedAreaId;
    if (areaId === null || state.mode !== 'area-selected') return;
    const area = this.readyDetail(areaId);
    const record = this.record(areaId);
    const current = field === 'name' ? (area?.name ?? record?.name ?? '') : (area?.description ?? '');
    this.cancelRenameCountdown();
    state.patch({
      detailsEdit: {
        areaId,
        field,
        baseVersion: this.currentVersion(areaId),
        text: initialText ?? current,
        error: null,
        saving: false,
        countdownUntil: null,
      },
    });
    state.requestFocus('rename-input');
    void this.locks.acquire(areaId, 'details');
  }

  setDetailsText(text: string): void {
    const edit = this.workspace.getState().detailsEdit;
    if (edit === null || edit.saving) return;
    this.workspace.getState().patch({ detailsEdit: { ...edit, text, error: null } });
  }

  /** `Esc` / *Cancel*: revert, no request (UX F-05 step 3); cancels a pending countdown. */
  cancelDetailsEdit(): void {
    this.cancelRenameCountdown();
    this.closeDetailsEdit();
  }

  private closeDetailsEdit(): void {
    const edit = this.workspace.getState().detailsEdit;
    if (edit === null) return;
    this.locks.release(edit.areaId);
    this.workspace.getState().patch({ detailsEdit: null });
  }

  private cancelRenameCountdown(): void {
    const handle = this.renameHandle;
    this.renameHandle = null;
    handle?.cancel();
  }

  private patchDetailsEdit(patch: Partial<DetailsEditState>): void {
    const edit = this.workspace.getState().detailsEdit;
    if (edit !== null) this.workspace.getState().patch({ detailsEdit: { ...edit, ...patch } });
  }

  /** `Enter` / blur / *Save*: sanitised, validated, optimistic, with the write retry policy. */
  commitDetailsEdit(): void {
    const edit = this.workspace.getState().detailsEdit;
    if (edit === null || edit.saving) return;
    const config = this.ctx.stores.runtime.getState().config;
    const multiline = edit.field === 'description';
    const text = sanitized(edit.text, multiline);
    const area = this.readyDetail(edit.areaId);
    const record = this.record(edit.areaId);
    const current = edit.field === 'name' ? (area?.name ?? record?.name ?? '') : (area?.description ?? '');
    if (edit.field === 'name' && text === '') {
      this.patchDetailsEdit({ error: base.save.nameRequired });
      return;
    }
    const max = edit.field === 'name' ? nameMaxLength(config) : descriptionMaxLength(config);
    if (codePointLength(text) > max) {
      this.patchDetailsEdit({
        error: edit.field === 'name' ? base.save.nameTooLong(max) : base.save.descriptionTooLong(max),
      });
      return;
    }
    if (text === current) {
      this.closeDetailsEdit();
      return;
    }
    // The version the user started from, not the newest one received: a rival rename that arrived meanwhile must
    // come back as a 409 (conflict panel), never be overwritten silently (UX F-09, Principle 3).
    const body =
      edit.field === 'name'
        ? { name: text, baseVersion: edit.baseVersion }
        : { description: text === '' ? null : text, baseVersion: edit.baseVersion };
    this.patchDetailsEdit({ saving: true, error: null });
    const handle = runWrite(() => this.ctx.api.areas.update(edit.areaId, body), {
      scheduler: this.ctx.scheduler,
      onCountdown: (until) => {
        this.patchDetailsEdit({ countdownUntil: until });
        this.ctx.clock.getState().tick();
      },
    });
    this.renameHandle = handle;
    void handle.result.then((outcome) => {
      if (this.renameHandle === handle) this.renameHandle = null;
      this.onDetailsOutcome(outcome, edit, text);
    });
  }

  private onDetailsOutcome(
    outcome: WriteOutcome<AreaMutationResponse>,
    edit: DetailsEditState,
    text: string,
  ): void {
    if (outcome.ok) {
      const { area } = outcome.value;
      this.applyArea(area, 'update');
      if (this.workspace.getState().selectedAreaId === area.id) {
        this.workspace.getState().patch({ detail: { areaId: area.id, status: 'ready', area } });
      }
      this.closeDetailsEdit();
      if (edit.field === 'name') {
        showToast(this.ctx, {
          lane: 'own',
          kind: 'info',
          code: 'toast.renamed',
          text: base.toast.renamed(displayName(area.name)),
          durationMs: TOAST_INFO_MS,
        });
      } else if (outcome.value.merged) {
        this.mergedToast(area, outcome.value.serverChangedFields, ['description']);
      }
      return;
    }
    if (outcome.cancelled) {
      this.patchDetailsEdit({ saving: false, countdownUntil: null });
      return;
    }
    const error = outcome.error;
    if (awaitsSignIn(this.ctx, error)) {
      this.patchDetailsEdit({ saving: false });
      this.hooks.retryAfterSignIn(() => {
        this.commitDetailsEdit();
      });
      return;
    }
    if (isApiError(error, 'VALIDATION_FAILED') && fieldError(error, edit.field) !== null) {
      const config = this.ctx.stores.runtime.getState().config;
      this.patchDetailsEdit({
        saving: false,
        error:
          edit.field === 'name'
            ? text === ''
              ? base.save.nameRequired
              : base.save.nameTooLong(nameMaxLength(config))
            : base.save.descriptionTooLong(descriptionMaxLength(config)),
      });
      return;
    }
    if (isApiError(error, 'VERSION_CONFLICT')) {
      this.patchDetailsEdit({ saving: false });
      this.hooks.openDetailsConflict(
        edit.areaId,
        edit.field === 'name' ? { name: text } : { description: text === '' ? null : text },
        error,
      );
      return;
    }
    if (isApiError(error, 'AREA_DELETED')) {
      const current = problemCurrent(error);
      this.closeDetailsEdit();
      if (current !== null) {
        this.applyArea(current, 'delete');
        this.workspace
          .getState()
          .patch({ detail: { areaId: current.id, status: 'deleted', area: current }, unsavedText: text });
      }
      return;
    }
    // Network / server: the name reverts; Retry re-opens the input with my text (UX F-05 step 4).
    this.closeDetailsEdit();
    const retry = (): void => {
      this.startDetailsEdit(edit.field, text);
      this.commitDetailsEdit();
    };
    showToast(this.ctx, {
      lane: 'own',
      kind: 'error',
      code: outcome.reason === 'network' ? 'toast.saveFailedNetwork' : 'toast.saveFailedServer',
      text:
        outcome.reason === 'network'
          ? base.toast.saveFailedNetwork(displayName(text))
          : base.toast.saveFailedServer,
      shortText: this.ctx.isPhone()
        ? outcome.reason === 'network'
          ? base.toast.saveFailedNetworkShort
          : base.toast.saveFailedServerShort
        : undefined,
      durationMs: null,
      action: { kind: 'retry', label: base.toast.retry, run: retry },
    });
  }

  /** `toast.autoMerged` naming the other editor when known (UX F-09 step 2). */
  mergedToast(
    area: AreaDto,
    theirs: readonly ('name' | 'description' | 'geometry')[],
    mine: readonly ('name' | 'description' | 'geometry')[],
  ): void {
    const actor = this.hooks.lastActor(area.id);
    const name = displayName(area.name);
    const text =
      actor === null
        ? base.toast.autoMergedUnknown(name, fieldList(theirs), fieldList(mine), area.version)
        : base.toast.autoMerged(
            displayUser(actor.displayName),
            name,
            fieldList(theirs),
            fieldList(mine),
            area.version,
          );
    showToast(this.ctx, {
      lane: 'own',
      kind: 'info',
      code: actor === null ? 'toast.autoMergedUnknown' : 'toast.autoMerged',
      text,
      durationMs: TOAST_INFO_MS,
    });
  }

  // -- delete with Undo (UX F-06) ------------------------------------------------------------

  /** *Delete* / `Delete` key. Anyone but the creator or an admin gets an explanation and nothing is sent. */
  deleteSelected(): void {
    const state = this.workspace.getState();
    const areaId = state.selectedAreaId;
    if (areaId === null || state.mode !== 'area-selected') return;
    const record = this.record(areaId);
    if (record === null) return;
    const detail = this.readyDetail(areaId);
    const me = currentUser(this.ctx);
    if (
      !canDelete(me, { createdById: record.createdById, createdBy: detail?.createdBy ?? record.createdBy })
    ) {
      const creator = detail?.createdBy ?? record.createdBy;
      showToast(this.ctx, {
        lane: 'own',
        kind: 'info',
        code: creator === null ? 'perm.deleteOwnerOnlyGeneric' : 'perm.deleteOwnerOnly',
        text:
          creator === null
            ? base.perm.deleteOwnerOnlyGeneric
            : base.perm.deleteOwnerOnly(displayUser(creator.displayName)),
        durationMs: TOAST_INFO_MS,
      });
      return;
    }
    const version = Math.max(record.version, detail?.version ?? 0);
    const name = detail?.name ?? record.name;
    this.performDelete(areaId, version, name, detail?.createdBy.displayName ?? null);
  }

  private performDelete(areaId: string, version: number, name: string, creatorName: string | null): void {
    const effects = this.ctx.stores.effects.getState();
    const neighbour = this.listNeighbour(areaId);
    effects.setHidden(areaId, true);
    // Focus moves to the next list item when the list is open, else to the map (UX F-06 step 2).
    this.close();
    if (this.workspace.getState().panel === 'list' && neighbour !== null)
      this.workspace.getState().requestFocus('list-item', neighbour);
    else this.workspace.getState().requestFocus('map');
    const shown = displayName(name);
    let deleted: AreaDto | null = null;
    let finished = false;
    const toastId = showToast(this.ctx, {
      lane: 'own',
      kind: 'undo',
      code: 'toast.deleted',
      text: base.toast.deleted(shown),
      durationMs: TOAST_UNDO_MS,
      action: {
        kind: 'undo',
        label: base.toast.undo,
        run: (viaKeyboard) => {
          if (!finished) {
            // Undo during the countdown cancels the pending DELETE: nothing is sent (UX F-06 step 5).
            handle.cancel();
            return;
          }
          if (deleted !== null) this.restoreArea(deleted, true, viaKeyboard);
        },
      },
    });
    const toasts = this.ctx.stores.toasts;
    const handle = runWrite(() => this.ctx.api.areas.remove(areaId, version), {
      scheduler: this.ctx.scheduler,
      onCountdown: (until) => {
        toasts.getState().update(
          toastId,
          until === null
            ? {
                kind: 'undo',
                text: base.toast.deleted(shown),
                durationMs: TOAST_UNDO_MS,
                countdownUntil: undefined,
                countdownText: undefined,
              }
            : {
                kind: 'countdown',
                text: base.rate.deleteToast(shown, formatCountdown(until - this.ctx.scheduler.now())),
                durationMs: null,
                countdownUntil: until,
                countdownText: (waitText: string) => base.rate.deleteToast(shown, waitText),
              },
        );
        this.ctx.clock.getState().tick();
      },
    });
    void handle.result.then((outcome) => {
      finished = true;
      if (outcome.ok) {
        deleted = outcome.value.area;
        this.applyArea(outcome.value.area, 'delete');
        effects.setHidden(areaId, false);
        return;
      }
      effects.setHidden(areaId, false);
      toasts.getState().dismiss(toastId);
      if (outcome.cancelled) return;
      this.onDeleteFailure(outcome.error, { areaId, version, name, creatorName });
    });
  }

  private onDeleteFailure(
    error: unknown,
    input: { areaId: string; version: number; name: string; creatorName: string | null },
  ): void {
    const shown = displayName(input.name);
    if (isApiError(error, 'VERSION_CONFLICT')) {
      const current = problemCurrent(error);
      if (current !== null) this.applyArea(current, 'update');
      const actor = current?.updatedBy.displayName ?? base.collab.someone;
      showToast(this.ctx, {
        lane: 'own',
        kind: 'undo',
        code: 'toast.deleteConflict',
        text: base.toast.deleteConflict(displayUser(actor), displayName(current?.name ?? input.name)),
        shortText: this.ctx.isPhone() ? base.toast.deleteConflictShort(displayUser(actor)) : undefined,
        durationMs: TOAST_UNDO_MS,
        action: {
          kind: 'show',
          label: base.toast.show,
          run: () => {
            this.select(input.areaId, 'keyboard');
          },
        },
      });
      return;
    }
    if (isApiError(error, 'AREA_DELETED')) {
      const current = problemCurrent(error);
      if (current !== null) this.applyArea(current, 'delete');
      return;
    }
    if (isApiError(error, 'FORBIDDEN')) {
      showToast(this.ctx, {
        lane: 'own',
        kind: 'error',
        code: 'toast.forbiddenDelete',
        text: base.toast.forbiddenDelete(displayUser(input.creatorName ?? base.collab.someone), shown),
        durationMs: null,
      });
      return;
    }
    if (awaitsSignIn(this.ctx, error)) {
      this.hooks.retryAfterSignIn(() => {
        this.performDelete(input.areaId, input.version, input.name, input.creatorName);
      });
      return;
    }
    showToast(this.ctx, {
      lane: 'own',
      kind: 'error',
      code: 'toast.deleteFailed',
      text: base.toast.deleteFailed(shown),
      shortText: this.ctx.isPhone() ? base.toast.deleteFailedShort : undefined,
      durationMs: null,
      action: {
        kind: 'retry',
        label: base.toast.retry,
        run: () => {
          this.performDelete(input.areaId, input.version, input.name, input.creatorName);
        },
      },
    });
  }

  /**
   * `POST .../restore` with the deleted version (Undo of a delete, or *Restore area* in the deleted state). A retried
   * restore whose first attempt succeeded is a success (`api/areas.ts`, SG-15).
   */
  restoreArea(tombstone: AreaDto, select: boolean, viaKeyboard = false): void {
    const handle = runWrite(() => this.ctx.api.areas.restore(tombstone.id, tombstone.version), {
      scheduler: this.ctx.scheduler,
      onCountdown: (until) => {
        this.workspace.getState().patch({ restoring: { areaId: tombstone.id, until } });
        this.ctx.clock.getState().tick();
      },
    });
    this.workspace.getState().patch({ restoring: { areaId: tombstone.id, until: null } });
    void handle.result.then((outcome) => {
      this.workspace.getState().patch({ restoring: null });
      if (outcome.ok) {
        const { area } = outcome.value;
        this.applyArea(area, 'restore');
        if (select) this.showSaved(area, viaKeyboard);
        else if (this.workspace.getState().detail?.areaId === area.id) {
          this.workspace.getState().patch({ detail: { areaId: area.id, status: 'ready', area } });
        }
        showToast(this.ctx, {
          lane: 'own',
          kind: 'info',
          code: 'toast.undeleted',
          text: base.toast.undeleted(displayName(area.name)),
          durationMs: TOAST_INFO_MS,
        });
        return;
      }
      if (outcome.cancelled) return;
      const error = outcome.error;
      if (isApiError(error, 'AREA_NOT_DELETED')) {
        const current = problemCurrent(error);
        if (current !== null) {
          this.applyArea(current, 'update');
          if (select) this.showSaved(current, false);
          showToast(this.ctx, {
            lane: 'own',
            kind: 'info',
            code: 'toast.alreadyRestored',
            text: base.toast.alreadyRestored(
              displayUser(current.updatedBy.displayName),
              displayName(current.name),
            ),
            durationMs: TOAST_INFO_MS,
          });
        }
        return;
      }
      if (isApiError(error, 'FORBIDDEN')) {
        showToast(this.ctx, {
          lane: 'own',
          kind: 'error',
          code: 'toast.forbiddenRestore',
          text: base.toast.forbiddenRestore(
            displayUser(tombstone.createdBy.displayName),
            displayName(tombstone.name),
          ),
          durationMs: null,
        });
        return;
      }
      showToast(this.ctx, {
        lane: 'own',
        kind: 'error',
        code: 'toast.saveFailedServer',
        text: base.toast.saveFailedServer,
        durationMs: null,
        action: {
          kind: 'retry',
          label: base.toast.retry,
          run: () => {
            this.restoreArea(tombstone, select, viaKeyboard);
          },
        },
      });
    });
  }

  /** *Restore area* in the deleted-by-other state (UX C-14, creator or admin). */
  restoreSelected(): void {
    const detail = this.workspace.getState().detail;
    if (detail?.status !== 'deleted') return;
    this.restoreArea(detail.area, false);
  }

  /** *Save a copy as a new area* in the deleted-by-other state (UX C-14, everyone else). */
  saveCopy(): void {
    const detail = this.workspace.getState().detail;
    if (detail?.status !== 'deleted') return;
    const exterior = detail.area.geometry.coordinates[0] ?? [];
    const config = this.ctx.stores.runtime.getState().config;
    const name = Array.from(base.panel.copyName(detail.area.name)).slice(0, nameMaxLength(config)).join('');
    this.hooks.saveCopy(exterior.slice(0, -1), name, detail.area.description ?? '');
  }

  /** The row after `areaId` in the Areas list (else the one before), for focus after a delete (UX F-06 step 2). */
  private listNeighbour(areaId: string): string | null {
    const state = this.workspace.getState();
    const rows = listedAreas(
      this.ctx.stores.areas.getState().byId.values(),
      this.ctx.stores.effects.getState().hidden,
      this.ctx.stores.mapView.getState().viewport,
      state.listFilter,
      state.listSort,
    );
    const index = rows.findIndex((area) => area.id === areaId);
    if (index === -1) return null;
    return (rows[index + 1] ?? rows[index - 1])?.id ?? null;
  }

  // -- history (UX F-07, C-13) ---------------------------------------------------------------

  /**
   * `H`, or the phone sheet's *History*: expands the History section (C-13; v2 it is a section under Selection, no
   * longer a tab), loads the versions if needed and, by keyboard, focuses the *Current* item.
   */
  showHistory(focusCurrent: boolean): void {
    const state = this.workspace.getState();
    const areaId = state.selectedAreaId;
    if (areaId === null) return;
    state.patch({
      historyExpanded: true,
      ...(state.layout === 'phone' ? { sheet: 'expanded' as const } : {}),
    });
    this.ensureHistory(areaId);
    if (focusCurrent) state.requestFocus('history-current');
  }

  /** The History header's disclosure button (`history-tab`): the state is kept for the session (UX C-13). */
  toggleHistory(): void {
    const state = this.workspace.getState();
    const expanded = !sectionExpanded(state, 'history');
    state.patch({ historyExpanded: expanded });
    if (expanded && state.selectedAreaId !== null) this.ensureHistory(state.selectedAreaId);
  }

  /** A collapsed History section loads nothing: selecting areas with it collapsed sends no `GET .../versions`. */
  private loadHistoryIfShown(areaId: string): void {
    if (sectionExpanded(this.workspace.getState(), 'history')) this.ensureHistory(areaId);
  }

  /** Loads the versions unless the list for this area is loading, or loaded and still current. */
  private ensureHistory(areaId: string): void {
    const history = this.workspace.getState().history;
    const stale =
      history?.status === 'ready' && (history.items[0]?.version ?? 0) < this.currentVersion(areaId);
    if (history?.areaId !== areaId || history.status === 'error' || stale) void this.loadHistory(areaId);
  }

  /**
   * v2 shows History expanded under Selection, so it must follow the selected area: a newer version (my rename, a
   * collaborator's change) reloads it while the section is expanded, or on the next expand (UX C-13, F-07).
   */
  syncHistory(): void {
    const state = this.workspace.getState();
    const areaId = state.selectedAreaId;
    if (areaId === null || state.history?.areaId !== areaId) return;
    if (sectionExpanded(state, 'history')) this.ensureHistory(areaId);
  }

  async loadHistory(areaId: string): Promise<void> {
    this.historyRequest += 1;
    const request = this.historyRequest;
    this.workspace.getState().patch({ history: { areaId, status: 'loading', items: [], retryAt: null } });
    try {
      const response = await this.ctx.api.areas.versions(areaId);
      if (request !== this.historyRequest) return;
      this.workspace
        .getState()
        .patch({ history: { areaId, status: 'ready', items: response.items, retryAt: null } });
    } catch (error) {
      if (request !== this.historyRequest) return;
      if (isApiError(error) && error.status === 429) {
        const retryAt = this.ctx.scheduler.now() + retryDelayMs(error, FALLBACK_READ_RETRY_MS);
        this.workspace.getState().patch({ history: { areaId, status: 'loading', items: [], retryAt } });
        this.ctx.scheduler.setTimeout(() => {
          if (request === this.historyRequest) void this.loadHistory(areaId);
        }, retryAt - this.ctx.scheduler.now());
        return;
      }
      this.workspace.getState().patch({ history: { areaId, status: 'error', items: [], retryAt: null } });
    }
  }

  /** Selecting a version: its geometry loads and shows as a ghost (UX F-07 step 3). */
  async previewVersion(version: number, viaKeyboard: boolean): Promise<void> {
    const state = this.workspace.getState();
    const areaId = state.selectedAreaId;
    if (areaId === null || (state.mode !== 'area-selected' && state.mode !== 'previewing-version')) return;
    try {
      const snapshot: AreaVersionDto = await this.ctx.api.areas.version(areaId, version);
      if (this.workspace.getState().selectedAreaId !== areaId) return;
      this.workspace.getState().patch({
        mode: 'previewing-version',
        preview: { areaId, version: snapshot, restoring: false, countdownUntil: null, viaKeyboard },
        sheet: 'peek',
      });
      const current = this.record(areaId);
      const positions = [...(snapshot.geometry?.coordinates[0] ?? []), ...(current?.rings[0] ?? [])];
      this.ctx.map()?.fitPositions(positions);
      if (viaKeyboard) this.workspace.getState().requestFocus('restore-version-button');
    } catch {
      showToast(this.ctx, {
        lane: 'own',
        kind: 'error',
        code: 'history.loadError',
        text: base.history.loadError,
        durationMs: null,
      });
    }
  }

  exitPreview(): void {
    const state = this.workspace.getState();
    const preview = state.preview;
    if (preview === null) return;
    state.patch({ mode: 'area-selected', preview: null });
    state.requestFocus('history-item', preview.version.version);
  }

  /** *Restore this version* = PATCH with that version's fields and `revertedFrom` (UX F-07 step 4). */
  restoreVersion(): void {
    const state = this.workspace.getState();
    const preview = state.preview;
    if (preview === null || preview.restoring) return;
    const areaId = preview.areaId;
    const record = this.record(areaId);
    const detail = this.readyDetail(areaId);
    const snapshot = preview.version;
    if (record === null || snapshot.geometry === undefined || snapshot.op === 'delete') return;
    const currentVersion = Math.max(record.version, detail?.version ?? 0);
    if (snapshot.version === currentVersion) return;
    const previous = detail;
    state.patch({ preview: { ...preview, restoring: true } });
    const body = {
      name: snapshot.name,
      description: snapshot.description,
      geometry: snapshot.geometry,
      baseVersion: currentVersion,
      revertedFrom: snapshot.version,
    };
    const handle = runWrite(() => this.ctx.api.areas.update(areaId, body), {
      scheduler: this.ctx.scheduler,
      onCountdown: (until) => {
        const current = this.workspace.getState().preview;
        if (current !== null)
          this.workspace.getState().patch({ preview: { ...current, countdownUntil: until } });
        this.ctx.clock.getState().tick();
      },
    });
    void handle.result.then((outcome) => {
      const current = this.workspace.getState().preview;
      if (current !== null)
        this.workspace.getState().patch({ preview: { ...current, restoring: false, countdownUntil: null } });
      if (outcome.ok) {
        this.onVersionRestored(outcome.value, snapshot.version, previous);
        return;
      }
      if (outcome.cancelled) return;
      if (isApiError(outcome.error, 'VERSION_CONFLICT')) {
        const latest = problemCurrent(outcome.error);
        if (latest !== null) {
          this.applyArea(latest, 'update');
          this.workspace.getState().patch({ detail: { areaId, status: 'ready', area: latest } });
        }
        announce(this.ctx, 'alert', base.history.restoreConflict);
        showToast(this.ctx, {
          lane: 'own',
          kind: 'info',
          code: 'history.restoreConflict',
          text: base.history.restoreConflict,
          durationMs: TOAST_INFO_MS,
        });
        this.ensureHistory(areaId);
        return;
      }
      showToast(this.ctx, {
        lane: 'own',
        kind: 'error',
        code: 'toast.saveFailedServer',
        text: base.toast.saveFailedServer,
        durationMs: null,
        action: {
          kind: 'retry',
          label: base.toast.retry,
          run: () => {
            this.restoreVersion();
          },
        },
      });
    });
  }

  private onVersionRestored(
    response: AreaMutationResponse,
    fromVersion: number,
    previous: AreaDto | null,
  ): void {
    const { area } = response;
    this.applyArea(area, 'update');
    this.workspace.getState().patch({
      mode: 'area-selected',
      preview: null,
      detail: { areaId: area.id, status: 'ready', area },
    });
    this.ensureHistory(area.id);
    this.workspace.getState().requestFocus('history-current');
    const name = displayName(area.name);
    if (response.noop) {
      showToast(this.ctx, {
        lane: 'own',
        kind: 'info',
        code: 'toast.restoreNoop',
        text: base.toast.restoreNoop(name, fromVersion),
        durationMs: TOAST_INFO_MS,
      });
      return;
    }
    const undo =
      previous === null
        ? undefined
        : {
            kind: 'undo' as const,
            label: base.toast.undo,
            run: () => {
              void this.ctx.api.areas
                .update(area.id, {
                  name: previous.name,
                  description: previous.description,
                  geometry: previous.geometry,
                  baseVersion: area.version,
                  revertedFrom: previous.version,
                })
                .then((result) => {
                  this.applyArea(result.area, 'update');
                  this.ensureHistory(area.id);
                })
                .catch(() => undefined);
            },
          };
    if (response.merged) {
      const actor = this.hooks.lastActor(area.id);
      showToast(this.ctx, {
        lane: 'own',
        kind: 'undo',
        code: 'toast.restoredVersionMerged',
        text: `${base.toast.restoredVersion(fromVersion, name, area.version)}. ${displayUser(actor?.displayName ?? base.collab.someone)}’s newer ${fieldList(response.serverChangedFields)} was kept.`,
        durationMs: TOAST_UNDO_MS,
        action: undo,
      });
      return;
    }
    showToast(this.ctx, {
      lane: 'own',
      kind: 'undo',
      code: 'toast.restoredVersion',
      text: base.toast.restoredVersion(fromVersion, name, area.version),
      durationMs: TOAST_UNDO_MS,
      action: undo,
    });
  }

  // -- helpers -------------------------------------------------------------------------------

  /**
   * Applies a server response to the store (a newer version always wins; equal versions upgrade the geometry). Every
   * caller passes an area this client asked for (its own write or a detail read), so it is kept even when no loaded
   * region covers it - otherwise my freshly saved area would show in the panel but not on the map.
   */
  applyArea(area: AreaDto, op: 'update' | 'delete' | 'restore'): void {
    const now = this.ctx.scheduler.now();
    this.ctx.stores.areas
      .getState()
      .update((state) => applyChange(state, { op, area }, now, { requested: true }).state);
  }

  dispose(): void {
    this.cancelRenameCountdown();
  }
}
