/**
 * Save conflicts (UX F-09 steps 3-6, C-19) and "deleted while editing" (UX F-09 step 5, C-20). The vocabulary is the
 * UX one (SPEC SG-30): *Keep mine*, *Take theirs*, *Review differences*, *Decide later*; *Restore it with my
 * changes*, *Save as a new area*, *Discard my changes*. Nothing is ever lost: every choice saves a version or offers
 * Undo.
 */
import type {
  AreaDto,
  AreaMutationResponse,
  MergeField,
  Position,
  UpdateAreaRequest,
} from '@snapland/shared';

import { problemCurrent } from '../api/areas';
import { isApiError } from '../api/http';
import { TOAST_INFO_MS, TOAST_UNDO_MS } from '../constants/ux';
import { base } from '../base/en';
import { displayName, displayUser } from '../lib/text';
import { runWrite } from '../lib/writeRetry';
import { openRing } from '../state/editReducer';
import { canDelete } from '../state/selectors';
import type { ConflictState } from '../state/workspaceStore';
import type { AreaFlow } from './areaFlow';
import type { WorkspaceContext } from './context';
import { announce, currentUser, showToast } from './context';
import type { EditFlow } from './editFlow';
import { mergeFields } from './problems';

type Mine = ConflictState['mine'];

export class ConflictFlow {
  constructor(
    private readonly ctx: WorkspaceContext,
    private readonly area: AreaFlow,
    private readonly edit: EditFlow,
  ) {}

  private get workspace() {
    return this.ctx.stores.workspace;
  }

  private open(areaId: string, mine: Mine, origin: ConflictState['origin'], error: unknown): void {
    if (!isApiError(error)) return;
    const current = problemCurrent(error);
    if (current === null) return;
    this.area.applyArea(current, 'update');
    const conflictingFields = mergeFields(error, 'conflictingFields');
    const serverChangedFields = mergeFields(error, 'serverChangedFields');
    const previous = this.workspace.getState().conflict;
    this.workspace.getState().patch({
      mode: 'resolving-conflict',
      panel: 'conflict',
      conflict: {
        areaId,
        mine,
        current,
        conflictingFields,
        serverChangedFields,
        origin,
        showMine: true,
        showTheirs: true,
        reviewing: false,
        choices: Object.fromEntries(conflictingFields.map((field) => [field, 'mine'])),
        changedAgain: previous?.areaId === areaId,
        saving: false,
      },
      detail: { areaId, status: 'ready', area: current },
      sheet: 'peek',
    });
    announce(this.ctx, 'alert', base.sr.conflictAlert);
    this.workspace.getState().requestFocus('conflict-heading');
  }

  openShape(areaId: string, rings: Position[][], error: unknown): void {
    this.open(areaId, { rings }, 'shape', error);
  }

  openDetails(areaId: string, mine: { name?: string; description?: string | null }, error: unknown): void {
    this.open(areaId, mine, 'details', error);
  }

  toggleShow(which: 'mine' | 'theirs'): void {
    const conflict = this.workspace.getState().conflict;
    if (conflict === null) return;
    this.workspace.getState().patch({
      conflict:
        which === 'mine'
          ? { ...conflict, showMine: !conflict.showMine }
          : { ...conflict, showTheirs: !conflict.showTheirs },
    });
  }

  /**
   * *Review differences*: the per-field view replaces the buttons, so the activated button disappears; focus moves
   * to the review's caption, never to <body> (UX section 8.3, WCAG 2.4.3).
   */
  review(): void {
    const conflict = this.workspace.getState().conflict;
    if (conflict === null) return;
    this.workspace.getState().patch({ conflict: { ...conflict, reviewing: true } });
    this.workspace.getState().requestFocus('conflict-review');
  }

  choose(field: MergeField, side: 'mine' | 'theirs'): void {
    const conflict = this.workspace.getState().conflict;
    if (conflict === null) return;
    this.workspace
      .getState()
      .patch({ conflict: { ...conflict, choices: { ...conflict.choices, [field]: side } } });
  }

  /** *Keep mine*: all my changed fields on top of their version (theirs stays in history). */
  keepMine(): void {
    const conflict = this.workspace.getState().conflict;
    if (conflict !== null)
      this.submit(
        conflict,
        this.bodyFor(conflict, () => 'mine'),
      );
  }

  /** *Save merged version* with the per-field choices of *Review differences*. */
  saveMerged(): void {
    const conflict = this.workspace.getState().conflict;
    if (conflict === null) return;
    const body = this.bodyFor(conflict, (field) => conflict.choices[field] ?? 'mine');
    if (!('name' in body) && !('description' in body) && !('geometry' in body)) {
      this.takeTheirs();
      return;
    }
    this.submit(conflict, body);
  }

  private bodyFor(
    conflict: ConflictState,
    side: (field: MergeField) => 'mine' | 'theirs',
  ): UpdateAreaRequest {
    const body: UpdateAreaRequest = { baseVersion: conflict.current.version };
    const conflicting = new Set(conflict.conflictingFields);
    const keeps = (field: MergeField): boolean => !conflicting.has(field) || side(field) === 'mine';
    if (conflict.mine.name !== undefined && keeps('name')) body.name = conflict.mine.name;
    if (conflict.mine.description !== undefined && keeps('description'))
      body.description = conflict.mine.description;
    if (conflict.mine.rings !== undefined && keeps('geometry'))
      body.geometry = { type: 'Polygon', coordinates: conflict.mine.rings };
    return body;
  }

  private submit(conflict: ConflictState, body: UpdateAreaRequest): void {
    if (conflict.saving) return;
    this.workspace.getState().patch({ conflict: { ...conflict, saving: true } });
    const handle = runWrite(() => this.ctx.api.areas.update(conflict.areaId, body), {
      scheduler: this.ctx.scheduler,
    });
    void handle.result.then((outcome) => {
      const latest = this.workspace.getState().conflict;
      if (latest !== null) this.workspace.getState().patch({ conflict: { ...latest, saving: false } });
      if (outcome.ok) {
        this.resolved(conflict, outcome.value);
        return;
      }
      if (outcome.cancelled) return;
      if (isApiError(outcome.error, 'VERSION_CONFLICT')) {
        // A third user saved meanwhile: the panel refreshes with the newest "theirs" (UX F-09 step 4).
        this.open(conflict.areaId, conflict.mine, conflict.origin, outcome.error);
        return;
      }
      if (isApiError(outcome.error, 'AREA_DELETED')) {
        const current = problemCurrent(outcome.error);
        if (current !== null) this.openDeletedWhileEditing(current);
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
            this.submit(conflict, body);
          },
        },
      });
    });
  }

  private resolved(conflict: ConflictState, response: AreaMutationResponse): void {
    const { area } = response;
    this.workspace.getState().patch({ conflict: null });
    if (conflict.origin === 'shape') this.edit.exit('committed', area.id);
    this.area.showSaved(area, true);
    showToast(this.ctx, {
      lane: 'own',
      kind: 'info',
      code: conflict.origin === 'shape' ? 'toast.editSaved' : 'toast.renamed',
      text:
        conflict.origin === 'shape' || conflict.mine.name === undefined
          ? base.toast.editSaved(displayName(area.name), area.version)
          : base.toast.renamed(displayName(area.name)),
      durationMs: TOAST_INFO_MS,
    });
  }

  /** *Take theirs*: my changes are discarded, their version shows, and Undo brings mine back (UX F-09 step 3). */
  takeTheirs(): void {
    const conflict = this.workspace.getState().conflict;
    if (conflict === null) return;
    const theirs = conflict.current;
    this.workspace.getState().patch({ conflict: null });
    if (conflict.origin === 'shape') this.edit.exit('cancelled');
    this.area.showSaved(theirs, true);
    const user = displayUser(theirs.updatedBy.displayName);
    showToast(this.ctx, {
      lane: 'own',
      kind: 'undo',
      code: 'toast.tookTheirs',
      text: base.toast.tookTheirs(user),
      shortText: this.ctx.isPhone() ? base.toast.tookTheirsShort(user) : undefined,
      durationMs: TOAST_UNDO_MS,
      action: {
        kind: 'undo',
        label: base.toast.undo,
        run: () => {
          this.undoTakeTheirs(conflict);
        },
      },
    });
  }

  private undoTakeTheirs(conflict: ConflictState): void {
    if (this.workspace.getState().selectedAreaId !== conflict.areaId) return;
    if (this.workspace.getState().mode !== 'area-selected') return;
    const latest = this.latestDetail(conflict.areaId) ?? conflict.current;
    const rings = conflict.mine.rings;
    if (conflict.origin === 'shape' && rings?.[0] !== undefined) {
      this.edit.begin(latest, openRing(rings[0]), null);
      return;
    }
    const field = conflict.mine.name !== undefined ? 'name' : 'description';
    this.area.startDetailsEdit(
      field,
      field === 'name' ? conflict.mine.name : (conflict.mine.description ?? ''),
    );
  }

  /** `Esc` / *Decide later*: back to where I was, my changes intact and unsaved (UX F-09 step 3). */
  decideLater(): void {
    const conflict = this.workspace.getState().conflict;
    if (conflict === null) return;
    this.workspace.getState().patch({ conflict: null, panel: 'area' });
    if (conflict.origin === 'shape') {
      this.workspace.getState().patch({ mode: 'editing-shape' });
      this.edit.onRemoteVersion(conflict.current, conflict.current.updatedBy);
      this.ctx.map()?.focusMap();
      return;
    }
    this.workspace.getState().patch({ mode: 'area-selected' });
    const field = conflict.mine.name !== undefined ? 'name' : 'description';
    this.area.startDetailsEdit(
      field,
      field === 'name' ? conflict.mine.name : (conflict.mine.description ?? ''),
    );
  }

  private latestDetail(areaId: string): AreaDto | null {
    const detail = this.workspace.getState().detail;
    return detail?.areaId === areaId && detail.status === 'ready' ? detail.area : null;
  }

  // -- deleted while editing (UX C-20) -----------------------------------------------------

  openDeletedWhileEditing(current: AreaDto): void {
    const edit = this.ctx.stores.edit.getState().edit;
    if (edit?.areaId !== current.id) return;
    this.area.applyArea(current, 'delete');
    this.workspace.getState().patch({
      deletedWhileEditing: {
        areaId: current.id,
        name: current.name,
        deletedBy: current.deletedBy,
        createdById: current.createdBy.id,
        creatorName: current.createdBy.displayName,
        restoreForbidden: false,
        busy: false,
      },
      detail: { areaId: current.id, status: 'deleted', area: current },
      conflict: null,
    });
    const user = displayUser(current.deletedBy?.displayName ?? base.collab.someone);
    announce(this.ctx, 'alert', base.deletedWhileEditing.title(user, displayName(current.name)));
  }

  /** Whether the C-20 dialog offers *Restore it with my changes* (creator or admin, and no 403 yet). */
  canRestore(): boolean {
    const dialog = this.workspace.getState().deletedWhileEditing;
    if (dialog === null || dialog.restoreForbidden) return false;
    return canDelete(currentUser(this.ctx), { createdById: dialog.createdById });
  }

  private setBusy(busy: boolean): void {
    const dialog = this.workspace.getState().deletedWhileEditing;
    if (dialog !== null) this.workspace.getState().patch({ deletedWhileEditing: { ...dialog, busy } });
  }

  private tombstone(): AreaDto | null {
    const detail = this.workspace.getState().detail;
    return detail?.status === 'deleted' ? detail.area : null;
  }

  /** *Restore it with my changes*: restore, then PATCH my shape on the restored version. */
  restoreWithMine(): void {
    const tombstone = this.tombstone();
    const edit = this.ctx.stores.edit.getState().edit;
    if (tombstone === null || edit === null) return;
    this.setBusy(true);
    const rings = [[...edit.points, edit.points[0] ?? [0, 0]]] as Position[][];
    void (async () => {
      try {
        const restored = await this.ctx.api.areas.restore(tombstone.id, tombstone.version);
        const saved = await this.ctx.api.areas.update(tombstone.id, {
          geometry: { type: 'Polygon', coordinates: rings },
          baseVersion: restored.area.version,
        });
        this.workspace.getState().patch({ deletedWhileEditing: null });
        this.edit.exit('committed', saved.area.id);
        this.area.showSaved(saved.area, true);
        showToast(this.ctx, {
          lane: 'own',
          kind: 'info',
          code: 'toast.editSaved',
          text: base.toast.editSaved(displayName(saved.area.name), saved.area.version),
          durationMs: TOAST_INFO_MS,
        });
      } catch (error) {
        this.setBusy(false);
        if (isApiError(error, 'FORBIDDEN')) {
          const dialog = this.workspace.getState().deletedWhileEditing;
          if (dialog !== null)
            this.workspace.getState().patch({ deletedWhileEditing: { ...dialog, restoreForbidden: true } });
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
        });
      }
    })();
  }

  /** *Save as a new area*: my shape and name under a brand-new id. */
  saveAsNew(): void {
    const tombstone = this.tombstone();
    const edit = this.ctx.stores.edit.getState().edit;
    if (tombstone === null || edit === null) return;
    this.setBusy(true);
    const first = edit.points[0];
    if (first === undefined) return;
    const request = {
      id: this.ctx.newId(),
      name: tombstone.name,
      description: tombstone.description,
      geometry: { type: 'Polygon' as const, coordinates: [[...edit.points, first]] },
    };
    void this.ctx.api.areas
      .create(request)
      .then((response) => {
        this.workspace.getState().patch({ deletedWhileEditing: null });
        this.edit.exit('cancelled');
        this.area.showSaved(response.area, true);
        showToast(this.ctx, {
          lane: 'own',
          kind: 'info',
          code: 'toast.saved',
          text: base.toast.saved(displayName(response.area.name), ''),
          durationMs: TOAST_INFO_MS,
        });
      })
      .catch(() => {
        this.setBusy(false);
        showToast(this.ctx, {
          lane: 'own',
          kind: 'error',
          code: 'toast.saveFailedServer',
          text: base.toast.saveFailedServer,
          durationMs: null,
        });
      });
  }

  /** *Discard my changes*: the edit ends; the area stays deleted and its panel closes. */
  discardDeleted(): void {
    this.workspace.getState().patch({ deletedWhileEditing: null });
    this.edit.exit('cancelled');
    this.area.close();
  }

  /** `Esc` never discards: the dialog closes, the edit continues and the panel shows the deleted state (UX C-20). */
  dismissDeletedDialog(): void {
    this.workspace.getState().patch({ deletedWhileEditing: null });
  }
}
