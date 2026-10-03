// QA evidence (T5 review round 1): the empty-view hint must not stay up once the view has an area, nor while the
// user is drawing (UX-AC-06 [M]; T5 task description, orchestrator smoke-test defect 1); and my own saved area must
// reach the areas store even when no region is tracked (e.g. the bounds load failed). Added by the qa-expert.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createAppServices } from '../app/services';
import { systemScheduler } from '../lib/scheduler';
import { beginRegion, completeRegion } from '../state/areasStore';
import { topNotice } from '../state/noticesStore';
import { areaDto } from '../test/factories';
import { flush, signedIn } from '../test/workspaceHarness';
import { Workspace } from './Workspace';

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

function setup() {
  const services = createAppServices({
    fetch: (input, init) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      if (url.endsWith('/areas') && init?.method === 'POST') {
        const body = JSON.parse(typeof init.body === 'string' ? init.body : '{}') as { id: string };
        // The saved area lies inside the view declared below.
        const area = areaDto({ id: body.id, west: 34.78, south: 32.08, size: 0.01 });
        return Promise.resolve(json(201, { area, merged: false, noop: false, serverChangedFields: [] }));
      }
      return Promise.resolve(json(404, { type: 'x', title: 'x', status: 404, code: 'NOT_FOUND' }));
    },
    scheduler: systemScheduler,
    locks: null,
    apiBase: '/api/v1',
  });
  services.adopt(signedIn());
  const workspace = new Workspace(services, {
    openSocket: () => {
      throw new Error('no socket in this test');
    },
    isOnline: () => true,
    random: () => 0.5,
    reducedMotion: () => false,
    isPhone: () => false,
    itmLayerEnabled: true,
    appVersion: 'test',
  });
  return { services, workspace };
}

beforeEach(() => {
  vi.useFakeTimers();
  localStorage.clear();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('QA: empty-hint visibility (UX C-17, UX-AC-06)', () => {
  function emptyView(services: ReturnType<typeof setup>['services']): void {
    // A view over Tel Aviv with no areas loaded.
    services.stores.mapView.getState().setView({
      center: { lat: 32.085, lng: 34.785 },
      zoom: 14,
      mercatorZoom: 14,
      viewport: [34.7, 32.0, 34.9, 32.2],
    });
  }

  function drawSquare(workspace: Workspace): void {
    workspace.drawing.start('pointer');
    workspace.drawing.place([34.78, 32.08]);
    workspace.drawing.place([34.79, 32.08]);
    workspace.drawing.place([34.79, 32.09]);
    workspace.drawing.place([34.78, 32.09]);
  }

  it('T5 defect 1: empty-hint ("Draw one with Draw area (D)") is not shown while drawing', () => {
    const { services, workspace } = setup();
    workspace.start();
    emptyView(services);
    expect(topNotice(services.stores.notices.getState())).toBe('empty-hint');
    drawSquare(workspace);
    expect(services.stores.workspace.getState().mode).toBe('drawing');
    expect(topNotice(services.stores.notices.getState())).not.toBe('empty-hint');
    workspace.dispose();
  });

  async function drawAndSave(workspace: Workspace, services: ReturnType<typeof setup>['services']) {
    drawSquare(workspace);
    expect(workspace.drawing.finish()).toBe(true);
    services.stores.drawing.getState().patchNaming({ name: 'Field' });
    workspace.drawing.save();
    await flush();
    await vi.advanceTimersByTimeAsync(0);
    await flush();
    expect(services.stores.workspace.getState().mode).toBe('area-selected');
  }

  it('UX-AC-06 an empty view shows empty-hint; after drawing and saving an area in that view it is gone', async () => {
    const { services, workspace } = setup();
    const stores = services.stores;
    workspace.start();
    // The view was loaded (fetched region, no areas) - the normal case.
    stores.areas
      .getState()
      .update((state) =>
        completeRegion(beginRegion(state, { id: 1, bbox: [34.6, 31.9, 35.0, 32.3], zoom: 14 }), 1, 1),
      );
    emptyView(services);
    expect(topNotice(stores.notices.getState())).toBe('empty-hint');
    await drawAndSave(workspace, services);
    expect(stores.areas.getState().byId.size).toBe(1);
    // The view now has an area, so the empty hint must be gone.
    expect(topNotice(stores.notices.getState())).not.toBe('empty-hint');
    workspace.dispose();
  });

  it('my own saved area reaches the areas store even when no region is tracked (bounds load failed)', async () => {
    const { services, workspace } = setup();
    workspace.start();
    emptyView(services);
    await drawAndSave(workspace, services);
    // showSaved() -> applyChange() drops an unknown area outside every fetched/loading region.
    expect(services.stores.areas.getState().byId.size).toBe(1);
    workspace.dispose();
  });
});
