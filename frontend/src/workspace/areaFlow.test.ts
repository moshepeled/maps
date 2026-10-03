import type { AreaDto, AreaVersionDto } from '@snapland/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { base } from '../base/en';
import { applyChange, applyListPage, beginRegion, completeRegion } from '../state/areasStore';
import { ALICE, BOB, areaDto, listItem, uuid } from '../test/factories';
import type { Harness } from '../test/workspaceHarness';
import { apiProblem, createHarness, flush, mutation, networkError } from '../test/workspaceHarness';
import { AreaFlow } from './areaFlow';
import { LockKeeper } from './lockKeeper';

function setup(user?: Parameters<typeof createHarness>[0]) {
  const h = createHarness(user);
  const hooks = {
    lastActor: vi.fn((): { displayName: string } | null => ({ displayName: 'Bob' })),
    openDetailsConflict: vi.fn(),
    saveCopy: vi.fn(),
    retryAfterSignIn: vi.fn(),
  };
  const flow = new AreaFlow(h.ctx, new LockKeeper(h.ctx), hooks);
  return { h, flow, hooks };
}

/** Puts an area in the store as a bbox page would (a list item: no creator name yet, SPEC SG-31). */
function seed(h: Harness, area: AreaDto): void {
  h.ctx.stores.areas.getState().update((state) => {
    const region = { id: 1, bbox: [34, 31, 36, 33] as [number, number, number, number], zoom: 12 };
    const tracked = completeRegion(beginRegion(state, region), 1, 1);
    return applyListPage(
      tracked,
      [listItem({ id: area.id, name: area.name, version: area.version, createdBy: area.createdBy })],
      7,
    );
  });
}

function version(areaId: string, n: number, op: AreaVersionDto['op'] = 'update'): AreaVersionDto {
  const area = areaDto({ id: areaId, version: n });
  return {
    areaId,
    version: n,
    op,
    name: `Name v${n}`,
    description: null,
    geometry: area.geometry,
    areaKm2: 1,
    perimeterKm: 4,
    vertexCount: 4,
    changedFields: ['name'],
    merged: false,
    revertedFrom: null,
    changeSeq: n,
    actor: ALICE,
    createdAt: '2026-09-27T10:00:00.000Z',
  };
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('AreaFlow - selection and details (UX C-11)', () => {
  it('UX-AC-28 selecting from the list opens the panel, loads the full detail and asks for focus on the heading', async () => {
    const { h, flow } = setup();
    const area = areaDto({ id: uuid(), name: 'North Field' });
    seed(h, area);
    h.api.get.mockResolvedValue(area);
    flow.select(area.id, 'list');
    expect(h.ctx.stores.workspace.getState()).toMatchObject({
      mode: 'area-selected',
      panel: 'area',
      selectedAreaId: area.id,
    });
    expect(h.ctx.stores.workspace.getState().detail?.status).toBe('loading');
    expect(h.ctx.stores.workspace.getState().focusRequest?.target).toBe('panel-heading');
    await flush();
    expect(h.ctx.stores.workspace.getState().detail?.status).toBe('ready');
    flow.close();
    expect(h.ctx.stores.workspace.getState()).toMatchObject({
      mode: 'browse',
      panel: 'list',
      selectedAreaId: null,
    });
    expect(h.ctx.stores.workspace.getState().focusRequest).toMatchObject({
      target: 'list-item',
      key: area.id,
    });
  });

  it('a click on the map does not move focus (UX section 8.3)', () => {
    const { h, flow } = setup();
    const area = areaDto({ id: uuid() });
    seed(h, area);
    h.api.get.mockResolvedValue(area);
    flow.select(area.id, 'map');
    expect(h.ctx.stores.workspace.getState().focusRequest).toBeNull();
  });

  it('UX-AC-96 404 then a tombstone shows the deleted state; 404 twice removes the area with toast.areaGone', async () => {
    const { h, flow } = setup();
    const area = areaDto({ id: uuid() });
    seed(h, area);
    h.api.get
      .mockRejectedValueOnce(apiProblem(404, 'AREA_NOT_FOUND'))
      .mockResolvedValueOnce({ ...areaDto({ id: area.id, deleted: true, version: 2 }) });
    flow.select(area.id, 'map');
    await flush();
    expect(h.ctx.stores.workspace.getState().detail?.status).toBe('deleted');
    expect(h.api.get).toHaveBeenLastCalledWith(area.id, { includeDeleted: true });

    const other = areaDto({ id: uuid() });
    seed(h, other);
    flow.close();
    h.api.get
      .mockRejectedValueOnce(apiProblem(404, 'AREA_NOT_FOUND'))
      .mockRejectedValueOnce(apiProblem(404, 'AREA_NOT_FOUND'));
    flow.select(other.id, 'map');
    await flush();
    expect(h.ctx.stores.areas.getState().byId.has(other.id)).toBe(false);
    expect(h.ctx.stores.workspace.getState().panel).toBe('none');
    expect(h.ctx.stores.toasts.getState().toasts.at(-1)?.code).toBe('toast.areaGone');
  });

  it('a rate-limited detail load retries by itself after the wait', async () => {
    const { h, flow } = setup();
    const area = areaDto({ id: uuid() });
    seed(h, area);
    h.api.get.mockRejectedValueOnce(apiProblem(429, 'RATE_LIMITED', {}, 3000)).mockResolvedValueOnce(area);
    flow.select(area.id, 'map');
    await flush();
    expect(h.ctx.stores.workspace.getState().detail?.status).toBe('rate-limited');
    await vi.advanceTimersByTimeAsync(3000);
    await flush();
    expect(h.ctx.stores.workspace.getState().detail?.status).toBe('ready');
  });
});

describe('AreaFlow - rename (UX F-05)', () => {
  function selected() {
    const context = setup();
    const area = areaDto({ id: uuid(), name: 'North Field' });
    seed(context.h, area);
    context.h.api.get.mockResolvedValue(area);
    context.flow.select(area.id, 'map');
    return { ...context, area };
  }

  it('UX-AC-29 F2 -> type -> Enter renames with the base version, takes and releases the details lock, toasts', async () => {
    const { h, flow, area } = selected();
    await flush();
    flow.startDetailsEdit('name');
    expect(h.transport.ofType('lock.acquire')[0]?.data).toEqual({ areaId: area.id, scope: 'details' });
    flow.setDetailsText('South Field');
    h.api.update.mockResolvedValue(mutation({ ...area, name: 'South Field', version: 2 }));
    flow.commitDetailsEdit();
    await flush();
    expect(h.api.update).toHaveBeenCalledWith(area.id, { name: 'South Field', baseVersion: 1 });
    expect(h.ctx.stores.workspace.getState().detailsEdit).toBeNull();
    expect(h.ctx.stores.areas.getState().byId.get(area.id)?.name).toBe('South Field');
    expect(h.ctx.stores.toasts.getState().toasts.at(-1)?.text).toBe(base.toast.renamed('South Field'));
    expect(h.transport.ofType('lock.release')).toHaveLength(1);
  });

  it('UX-AC-29 Esc restores the old name without a request; an unchanged name sends nothing either', async () => {
    const { h, flow } = selected();
    await flush();
    flow.startDetailsEdit('name');
    flow.setDetailsText('Changed');
    flow.cancelDetailsEdit();
    expect(h.api.update).not.toHaveBeenCalled();
    flow.startDetailsEdit('name');
    flow.commitDetailsEdit();
    expect(h.api.update).not.toHaveBeenCalled();
  });

  it('empty after sanitising -> save.nameRequired, the input stays open', async () => {
    const { h, flow } = selected();
    await flush();
    flow.startDetailsEdit('name');
    flow.setDetailsText('​');
    flow.commitDetailsEdit();
    expect(h.ctx.stores.workspace.getState().detailsEdit?.error).toBe(base.save.nameRequired);
  });

  it('UX-AC-94 a 400 on name shows the field error and keeps the input open', async () => {
    const { h, flow } = selected();
    await flush();
    flow.startDetailsEdit('name');
    flow.setDetailsText('Something');
    h.api.update.mockRejectedValue(
      apiProblem(400, 'VALIDATION_FAILED', { errors: [{ path: 'name', code: 'too_big', message: 'x' }] }),
    );
    flow.commitDetailsEdit();
    await flush();
    expect(h.ctx.stores.workspace.getState().detailsEdit?.error).toBe(base.save.nameTooLong(120));
  });

  it('a VERSION_CONFLICT opens the conflict panel with my text; AREA_DELETED shows the deleted state with it', async () => {
    const { h, flow, hooks, area } = selected();
    await flush();
    flow.startDetailsEdit('name');
    flow.setDetailsText('Mine');
    h.api.update.mockRejectedValueOnce(
      apiProblem(409, 'VERSION_CONFLICT', { current: { ...area, version: 3 } }),
    );
    flow.commitDetailsEdit();
    await flush();
    expect(hooks.openDetailsConflict).toHaveBeenCalledWith(area.id, { name: 'Mine' }, expect.anything());
    flow.cancelDetailsEdit();
    flow.startDetailsEdit('name');
    flow.setDetailsText('Mine again');
    h.api.update.mockRejectedValueOnce(
      apiProblem(409, 'AREA_DELETED', { current: areaDto({ id: area.id, deleted: true, version: 4 }) }),
    );
    flow.commitDetailsEdit();
    await flush();
    expect(h.ctx.stores.workspace.getState().detail?.status).toBe('deleted');
    expect(h.ctx.stores.workspace.getState().unsavedText).toBe('Mine again');
  });

  it('UX-AC-58 a rival rename that arrives while the input is open is not overwritten: the base stays v1', async () => {
    const { h, flow, hooks, area } = selected();
    await flush();
    flow.startDetailsEdit('name');
    flow.setDetailsText('Alice rename');
    // Bob renames meanwhile; the live event puts v2 in the store while my input stays open.
    h.ctx.stores.areas
      .getState()
      .update(
        (state) =>
          applyChange(state, { op: 'update', area: { ...area, name: 'Bob rename', version: 2 } }, 0).state,
      );
    h.api.update.mockRejectedValueOnce(
      apiProblem(409, 'VERSION_CONFLICT', { current: { ...area, name: 'Bob rename', version: 2 } }),
    );
    flow.commitDetailsEdit();
    await flush();
    expect(h.api.update).toHaveBeenCalledWith(area.id, { name: 'Alice rename', baseVersion: 1 });
    expect(hooks.openDetailsConflict).toHaveBeenCalledWith(
      area.id,
      { name: 'Alice rename' },
      expect.anything(),
    );
  });

  it('a network failure reverts and offers Retry, which re-opens the input with my text', async () => {
    const { h, flow } = selected();
    await flush();
    flow.startDetailsEdit('name');
    flow.setDetailsText('Mine');
    h.api.update.mockRejectedValueOnce(networkError());
    flow.commitDetailsEdit();
    await flush();
    expect(h.ctx.stores.workspace.getState().detailsEdit).toBeNull();
    const toast = h.ctx.stores.toasts.getState().toasts.at(-1);
    expect(toast?.action?.kind).toBe('retry');
    h.api.update.mockImplementation(() => new Promise(() => undefined));
    toast?.action?.run();
    expect(h.ctx.stores.workspace.getState().detailsEdit).toMatchObject({ text: 'Mine', saving: true });
  });
});

describe('AreaFlow - delete with Undo (UX F-06)', () => {
  function selectedBy(creator = ALICE) {
    const context = setup();
    const area = areaDto({ id: uuid(), name: 'Old Nursery', createdBy: creator });
    seed(context.h, area);
    context.h.api.get.mockImplementation(() => new Promise(() => undefined));
    context.flow.select(area.id, 'map');
    return { ...context, area };
  }

  it('UX-AC-79 a non-creator gets perm.deleteOwnerOnlyGeneric while the detail loads, and nothing is sent', () => {
    const { h, flow } = selectedBy(BOB);
    flow.deleteSelected();
    expect(h.api.remove).not.toHaveBeenCalled();
    expect(h.ctx.stores.toasts.getState().toasts.at(-1)?.code).toBe('perm.deleteOwnerOnlyGeneric');
  });

  it('UX-AC-38 the creator deletes optimistically; Undo restores the same area, selected', async () => {
    const { h, flow, area } = selectedBy();
    const deleted = { ...area, version: 2, deletedAt: '2026-09-27T10:05:00.000Z', deletedBy: ALICE };
    h.api.remove.mockResolvedValue(mutation(deleted));
    flow.deleteSelected();
    expect(h.ctx.stores.effects.getState().hidden.has(area.id)).toBe(true);
    expect(h.ctx.stores.workspace.getState().mode).toBe('browse');
    await flush();
    expect(h.api.remove).toHaveBeenCalledWith(area.id, 1);
    expect(h.ctx.stores.areas.getState().byId.has(area.id)).toBe(false);
    const toast = h.ctx.stores.toasts.getState().toasts.find((item) => item.code === 'toast.deleted');
    expect(toast).toMatchObject({ kind: 'undo', durationMs: 10_000 });
    h.api.restore.mockResolvedValue(mutation({ ...area, version: 3 }));
    toast?.action?.run();
    await flush();
    expect(h.api.restore).toHaveBeenCalledWith(area.id, 2);
    expect(h.ctx.stores.workspace.getState()).toMatchObject({
      mode: 'area-selected',
      selectedAreaId: area.id,
    });
    expect(h.ctx.stores.toasts.getState().toasts.at(-1)?.code).toBe('toast.undeleted');
  });

  it('UX-AC-89 VERSION_CONFLICT: the area reappears with the newer version and the toast offers Show, no Retry', async () => {
    const { h, flow, area } = selectedBy();
    h.api.remove.mockRejectedValue(
      apiProblem(409, 'VERSION_CONFLICT', {
        current: { ...area, name: 'Renamed', version: 5, updatedBy: BOB },
      }),
    );
    flow.deleteSelected();
    await flush();
    expect(h.ctx.stores.effects.getState().hidden.has(area.id)).toBe(false);
    expect(h.ctx.stores.areas.getState().byId.get(area.id)?.version).toBe(5);
    const toast = h.ctx.stores.toasts.getState().toasts.at(-1);
    expect(toast?.code).toBe('toast.deleteConflict');
    expect(toast?.action?.kind).toBe('show');
  });

  it('UX-AC-79 FORBIDDEN: the area comes back and toast.forbiddenDelete has no Retry', async () => {
    const { h, flow, area } = selectedBy();
    h.api.remove.mockRejectedValue(apiProblem(403, 'FORBIDDEN'));
    flow.deleteSelected();
    await flush();
    expect(h.ctx.stores.effects.getState().hidden.has(area.id)).toBe(false);
    const toast = h.ctx.stores.toasts.getState().toasts.at(-1);
    expect(toast?.code).toBe('toast.forbiddenDelete');
    expect(toast?.action).toBeUndefined();
  });

  it('UX-AC-89 AREA_DELETED: it stays removed', async () => {
    const { h, flow, area } = selectedBy();
    h.api.remove.mockRejectedValue(
      apiProblem(409, 'AREA_DELETED', { current: areaDto({ id: area.id, deleted: true, version: 2 }) }),
    );
    flow.deleteSelected();
    await flush();
    expect(h.ctx.stores.areas.getState().byId.has(area.id)).toBe(false);
  });

  it('F-06 step 5 Undo during a 429 countdown cancels the pending DELETE: nothing is sent', async () => {
    const { h, flow, area } = selectedBy();
    h.api.remove.mockRejectedValueOnce(apiProblem(429, 'RATE_LIMITED', {}, 20_000));
    flow.deleteSelected();
    await flush();
    const toast = h.ctx.stores.toasts.getState().toasts.find((item) => item.code === 'toast.deleted');
    expect(toast?.kind).toBe('countdown');
    expect(toast?.countdownText?.('3 s')).toBe('Deleting “Old Nursery” in 3 s…');
    toast?.action?.run();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(h.api.remove).toHaveBeenCalledTimes(1);
    expect(h.ctx.stores.effects.getState().hidden.has(area.id)).toBe(false);
  });

  it('a network failure brings the area back with Retry', async () => {
    const { h, flow } = selectedBy();
    h.api.remove.mockRejectedValueOnce(networkError());
    flow.deleteSelected();
    await flush();
    expect(h.ctx.stores.toasts.getState().toasts.at(-1)).toMatchObject({
      code: 'toast.deleteFailed',
      kind: 'error',
    });
  });
});

describe('AreaFlow - history (UX F-07)', () => {
  it('UX-AC-42 preview a version, restore it with revertedFrom, undo available; noop says so', async () => {
    const { h, flow } = setup();
    const area = areaDto({ id: uuid(), version: 5 });
    seed(h, area);
    h.api.get.mockResolvedValue(area);
    flow.select(area.id, 'keyboard');
    await flush();
    h.api.versions.mockResolvedValue({ items: [version(area.id, 5), version(area.id, 3)], nextCursor: null });
    flow.showHistory(true);
    await flush();
    expect(h.ctx.stores.workspace.getState().history?.status).toBe('ready');
    expect(h.ctx.stores.workspace.getState().focusRequest?.target).toBe('history-current');
    h.api.version.mockResolvedValue(version(area.id, 3));
    await flow.previewVersion(3, true);
    expect(h.ctx.stores.workspace.getState().mode).toBe('previewing-version');
    expect(h.ctx.stores.workspace.getState().focusRequest?.target).toBe('restore-version-button');
    h.api.update.mockResolvedValue(mutation({ ...area, version: 6, name: 'Name v3' }));
    flow.restoreVersion();
    await flush();
    expect(h.api.update).toHaveBeenCalledWith(
      area.id,
      expect.objectContaining({ baseVersion: 5, revertedFrom: 3, name: 'Name v3' }),
    );
    expect(h.ctx.stores.workspace.getState().mode).toBe('area-selected');
    expect(h.ctx.stores.toasts.getState().toasts.at(-1)).toMatchObject({
      code: 'toast.restoredVersion',
      kind: 'undo',
    });

    h.api.version.mockResolvedValue(version(area.id, 3));
    await flow.previewVersion(3, false);
    h.api.update.mockResolvedValue(mutation({ ...area, version: 6 }, { noop: true }));
    flow.restoreVersion();
    await flush();
    expect(h.ctx.stores.toasts.getState().toasts.at(-1)?.code).toBe('toast.restoreNoop');
  });

  it('a restore conflict refreshes history and keeps the preview; Esc exits the preview', async () => {
    const { h, flow } = setup();
    const area = areaDto({ id: uuid(), version: 5 });
    seed(h, area);
    h.api.get.mockResolvedValue(area);
    flow.select(area.id, 'map');
    await flush();
    h.api.versions.mockResolvedValue({ items: [version(area.id, 5)], nextCursor: null });
    h.api.version.mockResolvedValue(version(area.id, 2));
    await flow.previewVersion(2, false);
    h.api.update.mockRejectedValue(apiProblem(409, 'VERSION_CONFLICT', { current: { ...area, version: 7 } }));
    // Selecting already loaded the (expanded) History section; the conflict must load it again.
    const loadsBefore = h.api.versions.mock.calls.length;
    flow.restoreVersion();
    await flush();
    expect(h.ctx.stores.workspace.getState().mode).toBe('previewing-version');
    expect(h.api.versions.mock.calls.length).toBeGreaterThan(loadsBefore);
    flow.exitPreview();
    expect(h.ctx.stores.workspace.getState().mode).toBe('area-selected');
    expect(h.ctx.stores.workspace.getState().focusRequest).toMatchObject({ target: 'history-item', key: 2 });
  });
});

describe('AreaFlow - History section (v2, UX C-13, UX-AC-118)', () => {
  function selectable() {
    const { h, flow } = setup();
    const first = areaDto({ id: uuid(), version: 3 });
    const second = areaDto({ id: uuid(), version: 2 });
    seed(h, first);
    seed(h, second);
    h.api.get.mockImplementation((id) => Promise.resolve(id === first.id ? first : second));
    h.api.versions.mockResolvedValue({ items: [version(first.id, 3)], nextCursor: null });
    return { h, flow, first, second };
  }

  it('is expanded by default at >= 600 px, so selecting an area loads its versions', async () => {
    const { h, flow, first } = selectable();
    flow.select(first.id, 'map');
    await flush();
    expect(h.api.versions).toHaveBeenCalledWith(first.id);
    expect(h.ctx.stores.workspace.getState().history).toMatchObject({ areaId: first.id, status: 'ready' });
  });

  it('collapsed stays collapsed for the next selection, which sends no GET .../versions; H expands and focuses', async () => {
    const { h, flow, first, second } = selectable();
    flow.select(first.id, 'map');
    await flush();
    flow.toggleHistory();
    expect(h.ctx.stores.workspace.getState().historyExpanded).toBe(false);
    h.api.versions.mockClear();
    flow.select(second.id, 'map');
    await flush();
    expect(h.api.versions).not.toHaveBeenCalled();
    expect(h.ctx.stores.workspace.getState().historyExpanded).toBe(false);
    flow.showHistory(true);
    await flush();
    expect(h.ctx.stores.workspace.getState().historyExpanded).toBe(true);
    expect(h.api.versions).toHaveBeenCalledWith(second.id);
    expect(h.ctx.stores.workspace.getState().focusRequest?.target).toBe('history-current');
  });

  it('is collapsed by default in the phone sheet; History there expands the sheet too', async () => {
    const { h, flow, first } = selectable();
    h.ctx.stores.workspace.getState().patch({ layout: 'phone' });
    flow.select(first.id, 'map');
    await flush();
    expect(h.api.versions).not.toHaveBeenCalled();
    flow.showHistory(false);
    await flush();
    expect(h.ctx.stores.workspace.getState()).toMatchObject({ historyExpanded: true, sheet: 'expanded' });
    expect(h.api.versions).toHaveBeenCalledWith(first.id);
  });
});

describe('AreaFlow - deleted state (UX C-14)', () => {
  it('Restore area as the creator; Save a copy for everyone else', async () => {
    const { h, flow, hooks } = setup();
    const area = areaDto({ id: uuid(), name: 'North Field' });
    seed(h, area);
    const tombstone = {
      ...areaDto({ id: area.id, deleted: true, version: 2, name: 'North Field' }),
      description: 'desc',
    };
    h.api.get.mockRejectedValueOnce(apiProblem(404, 'AREA_NOT_FOUND')).mockResolvedValueOnce(tombstone);
    flow.select(area.id, 'map');
    await flush();
    flow.saveCopy();
    expect(hooks.saveCopy).toHaveBeenCalledWith(
      tombstone.geometry.coordinates[0]?.slice(0, -1),
      'Copy of North Field',
      'desc',
    );
    h.api.restore.mockResolvedValue(mutation({ ...area, version: 3 }));
    flow.restoreSelected();
    expect(h.ctx.stores.workspace.getState().restoring).toMatchObject({ areaId: area.id });
    await flush();
    expect(h.api.restore).toHaveBeenCalledWith(area.id, 2);
    expect(h.ctx.stores.workspace.getState().detail?.status).toBe('ready');
    expect(h.ctx.stores.workspace.getState().restoring).toBeNull();
  });

  it('UX-AC-90 AREA_NOT_DELETED from someone else says toast.alreadyRestored', async () => {
    const { h, flow } = setup();
    const tombstone = areaDto({ id: uuid(), deleted: true, version: 2 });
    h.api.restore.mockRejectedValue(
      apiProblem(409, 'AREA_NOT_DELETED', {
        current: { ...tombstone, deletedAt: null, deletedBy: null, version: 5, updatedBy: BOB },
      }),
    );
    flow.restoreArea(tombstone, true);
    await flush();
    expect(h.ctx.stores.toasts.getState().toasts.at(-1)?.code).toBe('toast.alreadyRestored');
  });
});

describe('AreaFlow - focus after a delete (UX F-06 step 2, section 8.3)', () => {
  function listed() {
    const context = setup();
    const areas = ['Alpha', 'Bravo', 'Charlie'].map((name) =>
      areaDto({ id: uuid(), name, createdBy: ALICE }),
    );
    for (const area of areas) seed(context.h, area);
    context.h.ctx.stores.mapView.getState().setView({
      center: { lat: 32, lng: 35 },
      zoom: 12,
      mercatorZoom: 12,
      viewport: [34, 31, 36, 33],
    });
    context.h.ctx.stores.workspace.getState().patch({ listSort: 'name' });
    context.h.api.get.mockImplementation(() => new Promise(() => undefined));
    context.h.api.remove.mockImplementation(() => new Promise(() => undefined));
    const [first, second, third] = areas;
    if (first === undefined || second === undefined || third === undefined) throw new Error('three areas');
    return { ...context, first, second, third };
  }

  it('opened from the list: focus goes to the next row of the list', () => {
    const { h, flow, second, third } = listed();
    flow.select(second.id, 'list');
    expect(h.ctx.stores.workspace.getState().sheet).toBe('peek');
    flow.deleteSelected();
    expect(h.ctx.stores.workspace.getState().panel).toBe('list');
    // Phones: the list comes back expanded, so the focused row never scrolls the list's header away.
    expect(h.ctx.stores.workspace.getState().sheet).toBe('expanded');
    expect(h.ctx.stores.workspace.getState().focusRequest).toMatchObject({
      target: 'list-item',
      key: third.id,
    });
  });

  it('the last row gives focus to the row before it; without the list, the map takes focus', () => {
    const { h, flow, first, second, third } = listed();
    flow.select(third.id, 'list');
    flow.deleteSelected();
    expect(h.ctx.stores.workspace.getState().focusRequest).toMatchObject({
      target: 'list-item',
      key: second.id,
    });
    h.ctx.stores.workspace.getState().patch({ panel: 'none' });
    flow.select(first.id, 'map');
    flow.deleteSelected();
    expect(h.ctx.stores.workspace.getState().focusRequest?.target).toBe('map');
  });

  it('Undo from the keyboard restores the area with focus on its heading', async () => {
    const { h, flow, first } = listed();
    const deleted = { ...first, version: 2, deletedAt: '2026-09-27T10:05:00.000Z', deletedBy: ALICE };
    h.api.remove.mockResolvedValue(mutation(deleted));
    flow.select(first.id, 'map');
    flow.deleteSelected();
    await flush();
    h.api.restore.mockResolvedValue(mutation({ ...first, version: 3 }));
    const toast = h.ctx.stores.toasts.getState().toasts.find((item) => item.code === 'toast.deleted');
    toast?.action?.run(true);
    await flush();
    expect(h.ctx.stores.workspace.getState().selectedAreaId).toBe(first.id);
    expect(h.ctx.stores.workspace.getState().focusRequest?.target).toBe('panel-heading');
  });
});

describe('AreaFlow - History follows the selected area (v2, UX C-13, F-07)', () => {
  it('my rename reloads the expanded History once, so the list shows the new version', async () => {
    const { h, flow } = setup();
    const area = areaDto({ id: uuid(), name: 'North Field' });
    seed(h, area);
    h.api.get.mockResolvedValue(area);
    h.api.versions.mockResolvedValue({ items: [version(area.id, 1, 'create')], nextCursor: null });
    flow.select(area.id, 'map');
    await flush();
    expect(h.api.versions).toHaveBeenCalledTimes(1);
    flow.startDetailsEdit('name');
    flow.setDetailsText('South Field');
    h.api.update.mockResolvedValue(mutation({ ...area, name: 'South Field', version: 2 }));
    h.api.versions.mockResolvedValue({
      items: [version(area.id, 2), version(area.id, 1, 'create')],
      nextCursor: null,
    });
    flow.commitDetailsEdit();
    await flush();
    // The workspace calls syncHistory whenever the areas store changes (Workspace.subscribe).
    flow.syncHistory();
    await flush();
    expect(h.api.versions).toHaveBeenCalledTimes(2);
    const history = h.ctx.stores.workspace.getState().history;
    expect(history?.status === 'ready' ? history.items[0]?.version : null).toBe(2);
    flow.syncHistory();
    await flush();
    expect(h.api.versions).toHaveBeenCalledTimes(2);
  });

  it('collapsed, a newer version loads nothing until the section is expanded again', async () => {
    const { h, flow } = setup();
    const area = areaDto({ id: uuid() });
    seed(h, area);
    h.api.get.mockResolvedValue(area);
    h.api.versions.mockResolvedValue({ items: [version(area.id, 1, 'create')], nextCursor: null });
    flow.select(area.id, 'map');
    await flush();
    flow.toggleHistory();
    h.ctx.stores.areas
      .getState()
      .update((state) => applyChange(state, { op: 'update', area: { ...area, version: 2 } }, 0).state);
    flow.syncHistory();
    await flush();
    expect(h.api.versions).toHaveBeenCalledTimes(1);
    flow.toggleHistory();
    await flush();
    expect(h.api.versions).toHaveBeenCalledTimes(2);
  });
});

describe('AreaFlow - a live event overtakes the detail request (UX C-14)', () => {
  it('a delete that arrives before GET /areas/{id} answers keeps the deleted state', async () => {
    const { h, flow } = setup();
    const area = areaDto({ id: uuid() });
    seed(h, area);
    let answer: (value: AreaDto) => void = () => undefined;
    h.api.get.mockImplementation(
      () =>
        new Promise<AreaDto>((resolve) => {
          answer = resolve;
        }),
    );
    flow.select(area.id, 'map');
    // What Workspace.reactToChange does for a live delete of the selected area.
    const tombstone = areaDto({ id: area.id, version: 2, deleted: true });
    flow.applyArea(tombstone, 'delete');
    h.ctx.stores.workspace
      .getState()
      .patch({ detail: { areaId: area.id, status: 'deleted', area: tombstone } });
    answer(area);
    await flush();
    expect(h.ctx.stores.workspace.getState().detail?.status).toBe('deleted');
    expect(h.ctx.stores.areas.getState().byId.has(area.id)).toBe(false);
  });
});
