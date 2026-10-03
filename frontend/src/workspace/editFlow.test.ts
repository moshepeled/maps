import type { AreaDto, Position } from '@snapland/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { base } from '../base/en';
import { applyChange, beginRegion, completeRegion } from '../state/areasStore';
import { ALICE, BOB, areaDto, squareRing, uuid } from '../test/factories';
import type { Harness } from '../test/workspaceHarness';
import { apiProblem, createHarness, flush, mutation, networkError } from '../test/workspaceHarness';
import { AreaFlow } from './areaFlow';
import { ConflictFlow } from './conflictFlow';
import { EditFlow, refusalText } from './editFlow';
import { LockKeeper } from './lockKeeper';

function seed(h: Harness, area: AreaDto): void {
  h.ctx.stores.areas.getState().update((state) => {
    const tracked = completeRegion(beginRegion(state, { id: 1, bbox: [34, 31, 36, 33], zoom: 12 }), 1, 1);
    return applyChange(tracked, { op: 'create', area }, 0).state;
  });
}

function setup(
  area: AreaDto = areaDto({ id: uuid(), name: 'North Field', west: 34.78, south: 32.08, size: 0.01 }),
) {
  const h = createHarness();
  const locks = new LockKeeper(h.ctx);
  const hooks = {
    lastActor: () => ({ displayName: 'Bob' }),
    openDetailsConflict: vi.fn(),
    saveCopy: vi.fn(),
    retryAfterSignIn: vi.fn(),
  };
  const areaFlow = new AreaFlow(h.ctx, locks, hooks);
  let conflict: ConflictFlow | null = null;
  const edit = new EditFlow(h.ctx, locks, {
    showSaved: (saved, viaKeyboard) => {
      areaFlow.showSaved(saved, viaKeyboard);
    },
    mergedToast: (merged, theirs, mine) => {
      areaFlow.mergedToast(merged, theirs, mine);
    },
    openShapeConflict: (areaId, rings, error) => {
      conflict?.openShape(areaId, rings, error);
    },
    openDeletedWhileEditing: (current) => {
      conflict?.openDeletedWhileEditing(current);
    },
    retryAfterSignIn: vi.fn(),
  });
  conflict = new ConflictFlow(h.ctx, areaFlow, edit);
  seed(h, area);
  h.ctx.stores.workspace.getState().patch({
    mode: 'area-selected',
    selectedAreaId: area.id,
    panel: 'area',
    detail: { areaId: area.id, status: 'ready', area },
  });
  return { h, edit, conflict, areaFlow, area };
}

const MOVED_OUTWARD: Position = [34.7925, 32.0925];

beforeEach(() => {
  vi.useFakeTimers();
  localStorage.clear();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('EditFlow - entering (UX F-04 step 1, F-10)', () => {
  it('UX-AC-31 Edit shape starts from the full detail: lock.acquire geometry, a draft with areaId, EditingShape', async () => {
    const { h, edit, area } = setup();
    edit.start('button');
    await flush();
    expect(h.ctx.stores.workspace.getState().mode).toBe('editing-shape');
    expect(h.ctx.stores.edit.getState().edit?.points).toHaveLength(4);
    expect(h.transport.ofType('lock.acquire')[0]?.data).toEqual({ areaId: area.id, scope: 'geometry' });
    expect(h.transport.ofType('draft.start')[0]?.data).toMatchObject({ areaId: area.id, resume: false });
    expect(h.ctx.stores.edit.getState().lock).toBe('mine');
    expect(h.ctx.stores.live.getState().status.text).toBe(base.sr.editMode('North Field'));
  });

  it('UX-AC-95 an area with a hole cannot be reshaped: E announces edit.holesDisabled and nothing starts', () => {
    const holed = areaDto({ id: uuid() });
    holed.geometry.coordinates.push(squareRing(34.782, 32.082, 0.002));
    const { h, edit } = setup(holed);
    edit.start('key');
    expect(h.ctx.stores.workspace.getState().mode).toBe('area-selected');
    expect(h.ctx.stores.live.getState().status.text).toBe(base.edit.holesDisabled);
  });

  it('UX-AC-56 E on an area locked by someone else only focuses Edit anyway and announces the hint', () => {
    const { h, edit, area } = setup();
    h.ctx.stores.locks.getState().snapshot([
      {
        areaId: area.id,
        holder: { userId: BOB.id, displayName: 'Bob', color: BOB.color },
        scope: 'geometry',
        expiresAt: new Date(Date.now() + 30_000).toISOString(),
      },
    ]);
    edit.start('key');
    expect(h.ctx.stores.workspace.getState().mode).toBe('area-selected');
    expect(h.ctx.stores.workspace.getState().focusRequest?.target).toBe('edit-shape-button');
    expect(h.ctx.stores.live.getState().status.text).toBe(base.lock.editAnywayHint('Bob'));
    edit.start('button');
    expect(h.ctx.stores.workspace.getState().mode).toBe('editing-shape');
    expect(h.ctx.stores.edit.getState().lock).toBe('both');
  });

  it('F-10 step 6 a LOCK_HELD race names the holder; LOCK_UNAVAILABLE makes the lock state unknown', async () => {
    const race = setup();
    race.h.transport.reply = (message) =>
      message.type === 'lock.acquire'
        ? {
            ok: false,
            error: {
              code: 'LOCK_HELD',
              message: 'held',
              details: { holder: { userId: BOB.id, displayName: 'Bob', color: BOB.color } },
            },
          }
        : { ok: true, data: {} };
    race.edit.start('button');
    await flush();
    expect(race.h.ctx.stores.edit.getState()).toMatchObject({
      lock: 'race',
      lockHolder: { displayName: 'Bob' },
    });

    const unknown = setup();
    unknown.h.transport.reply = (message) =>
      message.type === 'lock.acquire'
        ? { ok: false, error: { code: 'LOCK_UNAVAILABLE', message: 'redis' } }
        : { ok: true, data: {} };
    unknown.edit.start('button');
    await flush();
    expect(unknown.h.ctx.stores.edit.getState().lock).toBe('unknown');
  });

  it('a simplified / older detail is refetched before the edit starts', async () => {
    const { h, edit, area } = setup();
    h.ctx.stores.workspace.getState().patch({ detail: { areaId: area.id, status: 'loading' } });
    h.api.get.mockResolvedValue(area);
    edit.start('button');
    expect(h.ctx.stores.edit.getState().loadingDetail).toBe(true);
    await flush();
    expect(h.ctx.stores.workspace.getState().mode).toBe('editing-shape');
    expect(h.ctx.stores.edit.getState().loadingDetail).toBe(false);
  });
});

describe('EditFlow - point operations (UX C-12)', () => {
  it('UX-AC-33 a move that makes edges cross snaps back and says why', async () => {
    const { h, edit } = setup();
    edit.start('button');
    await flush();
    const before = h.ctx.stores.edit.getState().edit?.points;
    edit.dragStart(0);
    edit.drag(0, [34.795, 32.085]);
    expect(h.ctx.stores.edit.getState().dragging?.invalid).toBe(true);
    edit.dragEnd(0, [34.795, 32.085]);
    expect(h.ctx.stores.edit.getState().edit?.points).toEqual(before);
    expect(h.ctx.stores.edit.getState().edit?.refusal).toBe('reverted-crossing');
    expect(h.ctx.stores.live.getState().status.text).toBe(base.edit.revertedCrossing);
  });

  it('UX-AC-32 / 34 a valid move, a midpoint insert and a delete; 3 points cannot lose another', async () => {
    const { h, edit } = setup();
    edit.start('button');
    await flush();
    edit.dragEnd(2, MOVED_OUTWARD);
    expect(h.ctx.stores.edit.getState().edit?.points[2]).toEqual(MOVED_OUTWARD);
    edit.insertAt(0, [34.785, 32.079]);
    expect(h.ctx.stores.edit.getState().edit?.points).toHaveLength(5);
    expect(h.ctx.stores.edit.getState().edit?.selected).toBe(1);
    edit.deleteSelected();
    edit.deletePoint(0);
    expect(h.ctx.stores.edit.getState().edit?.points).toHaveLength(3);
    edit.deletePoint(0);
    expect(h.ctx.stores.edit.getState().edit?.refusal).toBe('min-points');
    expect(h.ctx.stores.live.getState().status.text).toBe(base.edit.minPoints);
  });

  it('UX-AC-35 / 36 keyboard and Move point: select, nudge, move-to; Esc deselects before it cancels', async () => {
    const { h, edit } = setup();
    edit.start('button');
    await flush();
    edit.cycle(1);
    expect(h.ctx.stores.edit.getState().edit?.selected).toBe(0);
    expect(h.ctx.stores.live.getState().status.text).toBe(base.edit.pointSelected(1, 4));
    edit.nudge(-10, 0);
    expect(h.ctx.stores.edit.getState().edit?.points[0]?.[0]).toBeCloseTo(34.7799, 6);
    edit.toggleMove();
    expect(h.ctx.stores.edit.getState().edit?.moveArmed).toBe(true);
    edit.moveSelectedTo([34.7795, 32.0795]);
    expect(h.ctx.stores.edit.getState().edit?.points[0]).toEqual([34.7795, 32.0795]);
    edit.escape();
    expect(h.ctx.stores.edit.getState().edit?.selected).toBeNull();
    expect(h.ctx.stores.workspace.getState().mode).toBe('editing-shape');
    edit.undo();
    edit.undo();
    expect(h.ctx.stores.edit.getState().edit?.points[0]).toEqual([34.78, 32.08]);
  });
});

describe('EditFlow - saving (UX F-04 step 8, F-09)', () => {
  async function dirty() {
    const context = setup();
    context.edit.start('button');
    await flush();
    context.edit.dragEnd(2, MOVED_OUTWARD);
    return context;
  }

  it('UX-AC-32 Save changes PATCHes the geometry with the base version, releases the lock and ends the draft', async () => {
    const { h, edit, area } = await dirty();
    h.api.update.mockResolvedValue(mutation({ ...area, version: 2 }));
    edit.save();
    expect(h.ctx.stores.workspace.getState().mode).toBe('saving-edit');
    expect(h.ctx.stores.effects.getState().pending.has(area.id)).toBe(true);
    await flush();
    const [id, body] = h.api.update.mock.calls[0] ?? [];
    expect(id).toBe(area.id);
    expect(body).toMatchObject({ baseVersion: 1, geometry: { type: 'Polygon' } });
    expect(h.ctx.stores.workspace.getState().mode).toBe('area-selected');
    expect(h.ctx.stores.edit.getState().edit).toBeNull();
    expect(h.transport.ofType('lock.release')).toHaveLength(1);
    expect(h.transport.ofType('draft.end').at(-1)?.data).toMatchObject({
      outcome: 'committed',
      areaId: area.id,
    });
    expect(h.ctx.stores.toasts.getState().toasts.at(-1)?.text).toBe(base.toast.editSaved('North Field', 2));
  });

  it('UX-AC-57 merged: true reads as the auto-merge toast naming the other editor', async () => {
    const { h, edit, area } = await dirty();
    h.api.update.mockResolvedValue(
      mutation(
        { ...area, version: 3, name: 'Renamed by Bob' },
        { merged: true, serverChangedFields: ['name'] },
      ),
    );
    edit.save();
    await flush();
    expect(h.ctx.stores.toasts.getState().toasts.at(-1)?.text).toBe(
      base.toast.autoMerged('Bob', 'Renamed by Bob', 'name change', 'shape change', 3),
    );
  });

  it('UX-AC-58 VERSION_CONFLICT opens the conflict panel; Keep mine re-saves on top of their version', async () => {
    const { h, edit, conflict, area } = await dirty();
    const theirs = { ...area, version: 2, updatedBy: BOB };
    h.api.update.mockRejectedValueOnce(
      apiProblem(409, 'VERSION_CONFLICT', {
        current: theirs,
        conflictingFields: ['geometry'],
        serverChangedFields: ['geometry'],
      }),
    );
    edit.save();
    await flush();
    const state = h.ctx.stores.workspace.getState();
    expect(state.mode).toBe('resolving-conflict');
    expect(state.panel).toBe('conflict');
    expect(state.conflict).toMatchObject({ origin: 'shape', conflictingFields: ['geometry'] });
    expect(h.ctx.stores.live.getState().alert.text).toBe(base.sr.conflictAlert);
    expect(state.focusRequest?.target).toBe('conflict-heading');
    h.api.update.mockResolvedValueOnce(mutation({ ...theirs, version: 3 }));
    conflict.keepMine();
    await flush();
    expect(h.api.update.mock.calls[1]?.[1]).toMatchObject({ baseVersion: 2, geometry: { type: 'Polygon' } });
    expect(h.ctx.stores.workspace.getState().mode).toBe('area-selected');
    expect(h.ctx.stores.edit.getState().edit).toBeNull();
  });

  it('Take theirs discards mine with an Undo that re-enters the edit; Decide later returns to editing', async () => {
    const { h, edit, conflict, area } = await dirty();
    const theirs = { ...area, version: 2, updatedBy: BOB };
    h.api.update.mockRejectedValue(
      apiProblem(409, 'VERSION_CONFLICT', {
        current: theirs,
        conflictingFields: ['geometry'],
        serverChangedFields: ['geometry'],
      }),
    );
    edit.save();
    await flush();
    conflict.decideLater();
    expect(h.ctx.stores.workspace.getState().mode).toBe('editing-shape');
    expect(h.ctx.stores.edit.getState().newerVersion?.version).toBe(2);
    edit.save();
    await flush();
    conflict.takeTheirs();
    expect(h.ctx.stores.workspace.getState().mode).toBe('area-selected');
    const toast = h.ctx.stores.toasts.getState().toasts.at(-1);
    expect(toast?.code).toBe('toast.tookTheirs');
    toast?.action?.run();
    expect(h.ctx.stores.workspace.getState().mode).toBe('editing-shape');
    expect(h.ctx.stores.edit.getState().edit?.points[2]).toEqual(MOVED_OUTWARD);
    expect(h.ctx.stores.edit.getState().edit?.baseVersion).toBe(2);
  });

  it('Review differences: choosing theirs for a field leaves it out of the merged save', async () => {
    const { h, conflict, area } = setup();
    h.api.update.mockResolvedValue(mutation({ ...area, version: 4 }));
    h.ctx.stores.workspace.getState().patch({
      conflict: {
        areaId: area.id,
        mine: { name: 'Mine', description: 'my text' },
        current: { ...area, version: 3 },
        conflictingFields: ['name'],
        serverChangedFields: ['name'],
        origin: 'details',
        showMine: true,
        showTheirs: true,
        reviewing: false,
        choices: { name: 'mine' },
        changedAgain: false,
        saving: false,
      },
    });
    conflict.review();
    conflict.choose('name', 'theirs');
    conflict.saveMerged();
    await flush();
    expect(h.api.update).toHaveBeenCalledWith(area.id, { baseVersion: 3, description: 'my text' });
  });

  it('UX-AC-60 AREA_DELETED opens the deleted-while-editing dialog; the creator can restore with the changes', async () => {
    const { h, edit, conflict, area } = await dirty();
    const tombstone = { ...area, version: 2, deletedAt: '2026-09-27T10:05:00.000Z', deletedBy: BOB };
    h.api.update.mockRejectedValueOnce(apiProblem(409, 'AREA_DELETED', { current: tombstone }));
    edit.save();
    await flush();
    expect(h.ctx.stores.workspace.getState().deletedWhileEditing).toMatchObject({
      areaId: area.id,
      name: 'North Field',
    });
    expect(conflict.canRestore()).toBe(true);
    h.api.restore.mockResolvedValue(mutation({ ...area, version: 3 }));
    h.api.update.mockResolvedValueOnce(mutation({ ...area, version: 4 }));
    conflict.restoreWithMine();
    await flush();
    expect(h.api.restore).toHaveBeenCalledWith(area.id, 2);
    expect(h.api.update.mock.calls.at(-1)?.[1]).toMatchObject({ baseVersion: 3 });
    expect(h.ctx.stores.workspace.getState().deletedWhileEditing).toBeNull();
    expect(h.ctx.stores.workspace.getState().mode).toBe('area-selected');
  });

  it('UX-AC-60 someone else may only save as a new area (a fresh id) or discard', async () => {
    const area = areaDto({ id: uuid(), name: 'Bob Field', createdBy: BOB });
    const { h, edit, conflict } = setup(area);
    edit.start('button');
    await flush();
    edit.dragEnd(2, MOVED_OUTWARD);
    conflict.openDeletedWhileEditing({
      ...area,
      version: 2,
      deletedAt: '2026-09-27T10:05:00.000Z',
      deletedBy: BOB,
    });
    expect(conflict.canRestore()).toBe(false);
    h.api.create.mockImplementation((request) =>
      Promise.resolve(mutation(areaDto({ id: request.id ?? 'no-id', name: request.name }))),
    );
    conflict.saveAsNew();
    await flush();
    const request = h.api.create.mock.calls[0]?.[0];
    expect(request?.id).not.toBe(area.id);
    expect(request?.name).toBe('Bob Field');
    expect(h.ctx.stores.edit.getState().edit).toBeNull();
  });

  it('a 422 keeps the edit with the server-invalid message; a network failure offers Retry', async () => {
    const { h, edit } = await dirty();
    h.api.update.mockRejectedValueOnce(
      apiProblem(422, 'INVALID_GEOMETRY', {
        errors: [{ path: 'geometry', code: 'GEOS_INVALID', message: 'x' }],
      }),
    );
    edit.save();
    await flush();
    expect(h.ctx.stores.workspace.getState().mode).toBe('editing-shape');
    expect(h.ctx.stores.edit.getState().serverInvalid?.code).toBe('GEOS_INVALID');
    h.api.update.mockRejectedValueOnce(networkError());
    edit.save();
    await flush();
    expect(h.ctx.stores.toasts.getState().toasts.at(-1)?.action?.kind).toBe('retry');
  });

  it('UX-AC-37 Cancel with changes reverts with an Undo that restores them', async () => {
    const { h, edit } = await dirty();
    edit.cancel();
    expect(h.ctx.stores.workspace.getState().mode).toBe('area-selected');
    expect(h.transport.ofType('draft.end').at(-1)?.data).toMatchObject({ outcome: 'cancelled' });
    const toast = h.ctx.stores.toasts.getState().toasts.at(-1);
    expect(toast?.code).toBe('toast.changesDiscarded');
    toast?.action?.run();
    expect(h.ctx.stores.edit.getState().edit?.points[2]).toEqual(MOVED_OUTWARD);
  });

  it('UX-AC-59 a newer version from someone else raises the early warning without touching my edit', async () => {
    const { h, edit, area } = await dirty();
    edit.onRemoteVersion({ ...area, version: 2 }, ALICE);
    edit.onRemoteVersion({ ...area, version: 1 }, BOB);
    expect(h.ctx.stores.edit.getState().newerVersion).toEqual({ user: ALICE, version: 2 });
    expect(h.ctx.stores.edit.getState().edit?.points[2]).toEqual(MOVED_OUTWARD);
  });
});

describe('refusalText (SPEC section 8.6: limits come from GET /config)', () => {
  it('the point-limit refusal names the runtime limit, not a hard-coded one', () => {
    expect(refusalText('max-points', { maxPoints: 499 })).toEqual({
      full: base.draw.maxPoints(499),
      short: base.draw.maxPointsShort(499),
    });
    expect(refusalText('too-large', { maxPoints: 499 })?.full).toBe(base.edit.tooLarge);
    expect(refusalText(null, { maxPoints: 499 })).toBeNull();
  });
});
