import type { AreaDto } from '@snapland/shared';
import type { AreaChangedData } from '../realtime/handlers';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createAppServices } from '../app/services';
import { base } from '../base/en';
import { systemScheduler } from '../lib/scheduler';
import { applyChange, beginRegion, completeRegion } from '../state/areasStore';
import { saveLocalDraft, saveViewPreference } from '../state/localDraft';
import { BOB, areaDto, uuid } from '../test/factories';
import { FakeSocket } from '../test/fakeSocket';
import { flush, ME, signedIn } from '../test/workspaceHarness';
import { createE2eHook } from './e2eHook';
import type { WorkspaceEnv } from './Workspace';
import { socketUrl, Workspace } from './Workspace';

const TICKET = 'a'.repeat(43);

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

/** `answer` responds to the requests a test cares about (null: the default below). */
function setup(env: Partial<WorkspaceEnv> = {}, answer: (url: string) => Response | null = () => null) {
  const requests: string[] = [];
  const services = createAppServices({
    fetch: (input) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      requests.push(url);
      const answered = answer(url);
      if (answered !== null) return Promise.resolve(answered);
      if (url.endsWith('/auth/ws-ticket'))
        return Promise.resolve(
          json(201, { ticket: TICKET, expiresAt: new Date(Date.now() + 30_000).toISOString() }),
        );
      if (url.endsWith('/auth/logout')) return Promise.resolve(new Response(null, { status: 204 }));
      return Promise.resolve(json(404, { type: 'x', title: 'x', status: 404, code: 'NOT_FOUND' }));
    },
    scheduler: systemScheduler,
    locks: null,
    apiBase: '/api/v1',
  });
  services.adopt(signedIn());
  const sockets: FakeSocket[] = [];
  const workspace = new Workspace(services, {
    openSocket: () => {
      const socket = new FakeSocket();
      sockets.push(socket);
      return socket;
    },
    isOnline: () => true,
    random: () => 0.5,
    reducedMotion: () => false,
    isPhone: () => false,
    itmLayerEnabled: true,
    appVersion: 'test',
    ...env,
  });
  return { services, workspace, sockets, requests };
}

async function connect(context: ReturnType<typeof setup>): Promise<FakeSocket> {
  context.workspace.start();
  await flush();
  await vi.advanceTimersByTimeAsync(0);
  const socket = context.sockets[0];
  if (socket === undefined) throw new Error('no socket');
  socket.open();
  socket.welcome();
  return socket;
}

beforeEach(() => {
  vi.useFakeTimers();
  localStorage.clear();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('Workspace wiring (SPEC section 8.6, UX section 3)', () => {
  it('connects with a fresh ticket, restates presence after welcome and reaches Live', async () => {
    const context = setup();
    const socket = await connect(context);
    expect(context.requests.some((url) => url.endsWith('/auth/ws-ticket'))).toBe(true);
    expect(context.services.stores.connection.getState().state).toBe('live');
    expect(socket.sentOfType('presence.update')[0]?.data).toEqual({ status: 'viewing' });
    context.workspace.dispose();
    expect(socket.closedWith).toBe(1000);
  });

  it('socketUrl uses wss on https pages and never carries more than the ticket', () => {
    expect(socketUrl('abc', { protocol: 'https:', host: 'example.test' })).toBe(
      'wss://example.test/ws?ticket=abc',
    );
    expect(socketUrl('a b', { protocol: 'http:', host: 'localhost:5173' })).toBe(
      'ws://localhost:5173/ws?ticket=a%20b',
    );
  });

  it("UX-AC-04 / 48 restores this user's view and base map; D-1: Aerial resolves to the GovMap 2022 ITM layer", () => {
    saveViewPreference(ME.id, { center: { lat: 32.08, lng: 34.78 }, zoom: 14, choice: 'aerial' });
    const context = setup();
    context.workspace.start();
    const view = context.services.stores.mapView.getState();
    expect(view.center).toEqual({ lat: 32.08, lng: 34.78 });
    expect(view.choice).toBe('aerial');
    expect(view.baseLayer).toBe('govmap-itm');
    context.workspace.toggleLayer();
    expect(context.services.stores.mapView.getState().baseLayer).toBe('map');
    expect(context.services.stores.live.getState().status.text).toBe(base.layer.switchedMap);
    context.workspace.dispose();
  });

  it('the ITM kill switch makes Aerial Esri World Imagery', () => {
    const context = setup({ itmLayerEnabled: false });
    expect(context.workspace.aerialLayer()).toBe('aerial');
    context.workspace.selectLayer('aerial');
    expect(context.services.stores.mapView.getState().baseLayer).toBe('aerial');
    expect(context.services.stores.live.getState().status.text).toBe(base.layer.switchedAerial);
  });

  it('UX-AC-20 a saved local drawing shows the restore banner; Restore returns to Drawing with the same points', () => {
    const points: [number, number][] = [
      [34.78, 32.08],
      [34.79, 32.08],
    ];
    saveLocalDraft(ME.id, { kind: 'drawing', points }, Date.now());
    const context = setup();
    context.workspace.start();
    expect(context.services.stores.notices.getState().restoreDraft).toBe(true);
    context.workspace.restoreLocalDraft();
    expect(context.services.stores.workspace.getState().mode).toBe('drawing');
    expect(context.services.stores.drawing.getState().drawing.points).toEqual(points);
    context.workspace.dispose();
  });

  it('keyboard: D draws, Esc cancels with an Undo toast, Ctrl+Z runs that Undo; letters do nothing while typing', async () => {
    const context = setup();
    await connect(context);
    const input = document.createElement('input');
    expect(
      context.workspace.handleGlobalKey({
        key: 'd',
        ctrlKey: false,
        metaKey: false,
        shiftKey: false,
        altKey: false,
        target: input,
      }),
    ).toBe(false);
    expect(
      context.workspace.handleGlobalKey({
        key: 'd',
        ctrlKey: false,
        metaKey: false,
        shiftKey: false,
        altKey: false,
        target: document.body,
      }),
    ).toBe(true);
    const stores = context.services.stores;
    expect(stores.workspace.getState().mode).toBe('drawing');
    context.workspace.drawing.place([34.78, 32.08]);
    context.workspace.escape();
    expect(stores.workspace.getState().mode).toBe('browse');
    expect(context.workspace.undo()).toBe(true);
    expect(stores.workspace.getState().mode).toBe('drawing');
    expect(stores.drawing.getState().drawing.points).toHaveLength(1);
    context.workspace.dispose();
  });

  it('UX-AC-60 a live delete of the area I am editing opens the deleted-while-editing dialog', async () => {
    const context = setup();
    const socket = await connect(context);
    const stores = context.services.stores;
    const area = areaDto({ id: uuid(), createdBy: BOB });
    stores.areas
      .getState()
      .update(
        (state) =>
          applyChange(
            completeRegion(beginRegion(state, { id: 1, bbox: [34, 31, 36, 33], zoom: 12 }), 1, 1),
            { op: 'create', area },
            0,
          ).state,
      );
    stores.workspace.getState().patch({
      mode: 'area-selected',
      selectedAreaId: area.id,
      panel: 'area',
      detail: { areaId: area.id, status: 'ready', area },
    });
    context.workspace.edit.begin(area, null, null);
    const deleted: AreaChangedData = {
      changeSeq: 5,
      op: 'delete',
      area: { ...area, version: 2, deletedAt: '2026-09-27T10:05:00.000Z', deletedBy: BOB },
      changedFields: ['deleted'],
      merged: false,
      previousName: null,
      actor: BOB,
    };
    socket.receive({ type: 'area.changed', data: deleted });
    expect(stores.workspace.getState().deletedWhileEditing?.areaId).toBe(area.id);
    context.workspace.dispose();
  });

  it('a live change of the selected area (not editing) refreshes the panel; its deletion shows the deleted state', async () => {
    const context = setup();
    const socket = await connect(context);
    const stores = context.services.stores;
    const area = areaDto({ id: uuid() });
    stores.areas
      .getState()
      .update(
        (state) =>
          applyChange(
            completeRegion(beginRegion(state, { id: 1, bbox: [34, 31, 36, 33], zoom: 12 }), 1, 1),
            { op: 'create', area },
            0,
          ).state,
      );
    stores.workspace.getState().patch({
      mode: 'area-selected',
      selectedAreaId: area.id,
      panel: 'area',
      detail: { areaId: area.id, status: 'ready', area },
    });
    socket.receive({
      type: 'area.changed',
      data: {
        changeSeq: 2,
        op: 'update',
        area: { ...area, name: 'Renamed', version: 2 },
        changedFields: ['name'],
        merged: false,
        previousName: area.name,
        actor: BOB,
      },
    });
    const detail = stores.workspace.getState().detail;
    expect(detail?.status === 'ready' ? detail.area.name : null).toBe('Renamed');
    socket.receive({
      type: 'area.changed',
      data: {
        changeSeq: 3,
        op: 'delete',
        area: { ...area, version: 3, deletedAt: '2026-09-27T10:05:00.000Z', deletedBy: BOB },
        changedFields: ['deleted'],
        merged: false,
        previousName: null,
        actor: BOB,
      },
    });
    expect(stores.workspace.getState().detail?.status).toBe('deleted');
    context.workspace.dispose();
  });

  it('my own change from another tab is not an echo: it refreshes the panel, and a delete during an edit opens DWE', async () => {
    const context = setup();
    const socket = await connect(context);
    const stores = context.services.stores;
    const area = areaDto({ id: uuid() });
    stores.areas
      .getState()
      .update(
        (state) =>
          applyChange(
            completeRegion(beginRegion(state, { id: 1, bbox: [34, 31, 36, 33], zoom: 12 }), 1, 1),
            { op: 'create', area },
            0,
          ).state,
      );
    stores.workspace.getState().patch({
      mode: 'area-selected',
      selectedAreaId: area.id,
      panel: 'area',
      detail: { areaId: area.id, status: 'ready', area },
    });
    const me = { id: ME.id, displayName: ME.displayName, color: ME.color };
    socket.receive({
      type: 'area.changed',
      data: {
        changeSeq: 2,
        op: 'update',
        area: { ...area, name: 'Renamed elsewhere', version: 2, updatedBy: me },
        changedFields: ['name'],
        merged: false,
        previousName: area.name,
        actor: me,
      },
    });
    const detail = stores.workspace.getState().detail;
    expect(detail?.status === 'ready' ? detail.area.name : null).toBe('Renamed elsewhere');
    const current = { ...area, name: 'Renamed elsewhere', version: 2 };
    context.workspace.edit.begin(current, null, null);
    socket.receive({
      type: 'area.changed',
      data: {
        changeSeq: 3,
        op: 'delete',
        area: { ...current, version: 3, deletedAt: '2026-09-27T10:05:00.000Z', deletedBy: me },
        changedFields: ['deleted'],
        merged: false,
        previousName: null,
        actor: me,
      },
    });
    expect(stores.workspace.getState().deletedWhileEditing?.areaId).toBe(area.id);
    context.workspace.dispose();
  });

  it('a live change of the selected area reloads its expanded History and warns an open rename (F-09 step 1)', async () => {
    const context = setup();
    const socket = await connect(context);
    const stores = context.services.stores;
    const area = areaDto({ id: uuid() });
    stores.areas
      .getState()
      .update(
        (state) =>
          applyChange(
            completeRegion(beginRegion(state, { id: 1, bbox: [34, 31, 36, 33], zoom: 12 }), 1, 1),
            { op: 'create', area },
            0,
          ).state,
      );
    stores.workspace.getState().patch({
      mode: 'area-selected',
      selectedAreaId: area.id,
      panel: 'area',
      detail: { areaId: area.id, status: 'ready', area },
      history: {
        areaId: area.id,
        status: 'ready',
        items: [
          {
            areaId: area.id,
            version: 1,
            op: 'create',
            name: area.name,
            description: null,
            geometry: area.geometry,
            areaKm2: area.areaKm2,
            perimeterKm: area.perimeterKm,
            vertexCount: area.vertexCount,
            changedFields: [],
            merged: false,
            revertedFrom: null,
            changeSeq: 1,
            actor: BOB,
            createdAt: area.createdAt,
          },
        ],
        retryAt: null,
      },
    });
    context.workspace.area.startDetailsEdit('name');
    const versionsUrl = `/areas/${area.id}/versions`;
    const loadsBefore = context.requests.filter((url) => url.includes(versionsUrl)).length;
    socket.receive({
      type: 'area.changed',
      data: {
        changeSeq: 2,
        op: 'update',
        area: { ...area, name: 'Renamed', version: 2 },
        changedFields: ['name'],
        merged: false,
        previousName: area.name,
        actor: BOB,
      },
    });
    await flush();
    expect(context.requests.filter((url) => url.includes(versionsUrl)).length).toBe(loadsBefore + 1);
    expect(stores.live.getState().status.text).toBe(base.edit.newerVersion(BOB.displayName, 2));
    context.workspace.dispose();
  });

  it('F-11 a session that ends while the socket is open closes the live channel: the pill reads Signed out', async () => {
    const context = setup();
    const socket = await connect(context);
    expect(context.services.stores.connection.getState().state).toBe('live');
    context.services.stores.auth.getState().markSessionProblem('expired');
    expect(socket.closedWith).toBe(1000);
    expect(context.services.stores.connection.getState().state).toBe('signed-out');
    await vi.advanceTimersByTimeAsync(60_000);
    expect(context.sockets).toHaveLength(1);
    context.workspace.dispose();
  });

  it('F-14 sign-out without unsaved work logs out and goes to /signin; with unsaved work it asks first', async () => {
    const context = setup();
    await connect(context);
    context.workspace.drawing.start('pointer');
    context.workspace.drawing.place([34.78, 32.08]);
    context.workspace.requestSignOut();
    expect(context.services.stores.workspace.getState().signOutConfirmOpen).toBe(true);
    await context.workspace.signOut(true);
    expect(context.requests.some((url) => url.endsWith('/auth/logout'))).toBe(true);
    expect(context.services.stores.auth.getState().status).toBe('signed-out');
    expect(window.location.pathname + window.location.search).toBe('/signin?signedout=1');
  });

  it('UX-AC-88 a remote draft with no message for 15 s is swept away', async () => {
    const context = setup();
    const socket = await connect(context);
    const draftId = uuid();
    socket.receive({
      type: 'draft.updated',
      data: {
        draftId,
        user: { id: BOB.id, displayName: 'Bob', color: BOB.color },
        areaId: null,
        rev: 1,
        vertices: [],
        cursor: null,
      },
    });
    expect(context.services.stores.remoteDrafts.getState().drafts.has(draftId)).toBe(true);
    await vi.advanceTimersByTimeAsync(14_000);
    expect(context.services.stores.remoteDrafts.getState().drafts.has(draftId)).toBe(true);
    await vi.advanceTimersByTimeAsync(1_500);
    expect(context.services.stores.remoteDrafts.getState().drafts.has(draftId)).toBe(false);
    context.workspace.dispose();
  });

  it('the E2E hook exposes the section 8.6 shape read-only', async () => {
    const context = setup();
    await connect(context);
    const hook = createE2eHook(context.workspace);
    expect(hook.mode).toBe('browse');
    expect(hook.connection).toEqual({ state: 'live', instanceId: 'backend-2' });
    expect(hook.baseLayer).toBe('map');
    context.workspace.drawing.start('pointer');
    context.workspace.drawing.place([34.78, 32.08]);
    context.workspace.drawing.place([34.79, 32.08]);
    context.workspace.drawing.pointer([34.79, 32.09]);
    const draft = hook.draft;
    expect(draft.points).toHaveLength(2);
    expect(draft.provisional).toEqual([34.79, 32.09]);
    expect(draft.areaKm2).toBeGreaterThan(0);
    expect(hook.areasInView).toEqual([]);
    expect(hook.remoteDrafts).toEqual([]);
    expect(hook.view.zoom).toBe(8);
    expect(hook.project(32.08, 34.78)).toBeNull();
    expect(hook.perf.lastRegionLoad).toBeNull();
    expect(Object.keys(hook)).toEqual(
      expect.arrayContaining([
        'mode',
        'selectedAreaId',
        'draft',
        'areasInView',
        'connection',
        'baseLayer',
        'remoteDrafts',
        'locks',
        'view',
        'project',
        'perf',
      ]),
    );
    context.workspace.dispose();
  });
});

describe('Inspector commands (v2: UX C-28, section 6.1, section 8.1)', () => {
  const key = (value: string) => ({
    key: value,
    ctrlKey: false,
    metaKey: false,
    shiftKey: false,
    altKey: false,
    target: document.body,
  });

  it('UX-AC-116 P shows the docked People section, moves focus to its header and clears the busy counter', () => {
    const { services, workspace } = setup();
    const stores = services.stores;
    stores.workspace.getState().patch({ peopleExpanded: false });
    stores.presence.getState().setChangesCounter(4);
    expect(workspace.handleGlobalKey(key('p'))).toBe(true);
    expect(stores.workspace.getState()).toMatchObject({ peopleExpanded: true, presenceOpen: false });
    expect(stores.workspace.getState().focusRequest?.target).toBe('people-header');
    expect(stores.workspace.getState().revealRequest?.section).toBe('people');
    expect(stores.presence.getState().changesCounter).toBe(0);
    // Not a toggle: pressing it again keeps People expanded.
    workspace.showPeople(false);
    expect(stores.workspace.getState().peopleExpanded).toBe(true);
    workspace.dispose();
  });

  it('a phone keeps the v1.2 presence popover toggle', () => {
    const { services, workspace } = setup();
    services.stores.workspace.getState().patch({ layout: 'phone' });
    workspace.showPeople(false);
    expect(services.stores.workspace.getState().presenceOpen).toBe(true);
    workspace.showPeople(false);
    expect(services.stores.workspace.getState().presenceOpen).toBe(false);
    workspace.dispose();
  });

  it('UX-AC-121 overlay: P opens the inspector for People, Esc closes it; section toggles are kept', () => {
    const { services, workspace } = setup();
    const stores = services.stores;
    stores.workspace.getState().patch({ layout: 'overlay' });
    workspace.showPeople(true);
    expect(stores.workspace.getState()).toMatchObject({ inspectorExtras: true, peopleExpanded: true });
    workspace.toggleSection('activity');
    expect(stores.workspace.getState().activityExpanded).toBe(true);
    expect(workspace.escape()).toBe(true);
    expect(stores.workspace.getState().inspectorExtras).toBe(false);
    expect(workspace.escape()).toBe(false);
    workspace.dispose();
  });

  it('expanding People with its header clears the busy counter; collapsing does not', () => {
    const { services, workspace } = setup();
    const stores = services.stores;
    stores.presence.getState().setChangesCounter(2);
    workspace.toggleSection('people'); // docked default: expanded -> collapsed
    expect(stores.workspace.getState().peopleExpanded).toBe(false);
    expect(stores.presence.getState().changesCounter).toBe(2);
    workspace.toggleSection('people');
    expect(stores.workspace.getState().peopleExpanded).toBe(true);
    expect(stores.presence.getState().changesCounter).toBe(0);
    workspace.dispose();
  });
});

describe('back online after a long outage (UX F-13 step 6, section 8 F1 of the demo storyboard)', () => {
  /**
   * Bob renames each of `renamed` (in view) while my live channel is down for 12 s; the Limited poll brings the changes,
   * then the channel comes back. Returns the back-online toast's text.
   */
  async function backOnlineText(renamed: readonly AreaDto[]): Promise<string | undefined> {
    let feed = renamed.map((area, index) => ({
      changeSeq: index + 2,
      op: 'update',
      areaId: area.id,
      version: index + 2,
      area: {
        ...area,
        name: `Renamed ${String(index)}`,
        version: index + 2,
        changeSeq: index + 2,
        updatedBy: BOB,
      },
      changedFields: ['name'],
      merged: false,
      actor: BOB,
      occurredAt: '2026-09-27T10:06:00.000Z',
    }));
    const context = setup({}, (url) => {
      if (!url.includes('/areas/changes')) return null;
      const items = feed;
      feed = [];
      return json(200, {
        items,
        nextSince: renamed.length + 1,
        hasMore: false,
        latestChangeSeq: renamed.length + 1,
      });
    });
    const socket = await connect(context);
    const stores = context.services.stores;
    stores.mapView.getState().setView({
      center: { lat: 32.085, lng: 34.785 },
      zoom: 14,
      mercatorZoom: 14,
      viewport: [34.7, 32.0, 34.9, 32.2],
    });
    stores.areas.getState().update((state) => {
      let next = completeRegion(beginRegion(state, { id: 1, bbox: [34, 31, 36, 33], zoom: 12 }), 1, 1);
      for (const area of new Set(renamed)) next = applyChange(next, { op: 'create', area }, 0).state;
      return next;
    });
    socket.drop();
    await vi.advanceTimersByTimeAsync(12_000);
    expect(stores.connection.getState().state).toBe('limited');
    const next = context.sockets.at(-1);
    if (next === undefined || next === socket) throw new Error('no reconnect attempt');
    next.open();
    next.welcome();
    await vi.advanceTimersByTimeAsync(0);
    expect(stores.connection.getState().state).toBe('live');
    const text = stores.toasts.getState().toasts.find((toast) => toast.code === 'toast.backOnline')?.text;
    context.workspace.dispose();
    return text;
  }

  it('counts the areas that changed, not the changes, with the right plural', async () => {
    const park = areaDto({ id: uuid() });
    const market = areaDto({ id: uuid(), west: 34.8 });
    expect(await backOnlineText([park, park])).toBe(
      'You’re back online. 1 area in view changed while you were away.',
    );
    expect(await backOnlineText([park, market])).toBe(
      'You’re back online. 2 areas in view changed while you were away.',
    );
  });
});

describe('Workspace.start and the frame layout', () => {
  it('keeps the layout the view wrote before start (it describes the screen, not the user)', () => {
    const { services, workspace } = setup();
    services.stores.workspace.getState().patch({ layout: 'overlay', panel: 'list' });
    workspace.start();
    expect(services.stores.workspace.getState()).toMatchObject({ layout: 'overlay', panel: 'none' });
    workspace.dispose();
  });
});
