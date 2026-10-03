// QA evidence (T5 review round 1): UX F-11 / C-22 - after one user signs out, another user signing in on the same tab
// must never see the previous user's in-memory drawing ("Previous user's draft is not shown, workspace reloads as new
// user"). The stores live in the app services (created once per tab), so a new Workspace alone is not enough.
// Added by the qa-expert.
import type { UserDto } from '@snapland/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { AppServices } from '../app/services';
import { createAppServices } from '../app/services';
import { systemScheduler } from '../lib/scheduler';
import { BOB } from '../test/factories';
import { signedIn } from '../test/workspaceHarness';
import { Workspace } from './Workspace';

const BOB_USER: UserDto = {
  id: BOB.id,
  username: 'bob',
  displayName: BOB.displayName,
  color: BOB.color,
  role: 'user',
  createdAt: '2026-09-27T10:00:00.000Z',
};

function newWorkspace(services: AppServices): Workspace {
  return new Workspace(services, {
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
}

beforeEach(() => {
  vi.useFakeTimers();
  localStorage.clear();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('QA: switching users in one tab (UX F-11, C-22)', () => {
  it("Bob, signing in after Alice signed out, does not inherit Alice's drawing or mode", async () => {
    const services = createAppServices({
      fetch: () =>
        Promise.resolve(
          new Response(JSON.stringify({ type: 'x', title: 'x', status: 404, code: 'NOT_FOUND' }), {
            status: 404,
            headers: { 'Content-Type': 'application/json' },
          }),
        ),
      scheduler: systemScheduler,
      locks: null,
      apiBase: '/api/v1',
    });
    services.adopt(signedIn()); // Alice
    const alice = newWorkspace(services);
    alice.start();
    alice.drawing.start('pointer');
    alice.drawing.place([34.78, 32.08]);
    alice.drawing.place([34.79, 32.08]);
    alice.drawing.place([34.79, 32.09]);
    await alice.signOut(false);
    alice.dispose(); // WorkspaceRoot unmounts while the sign-in page shows

    services.adopt(signedIn(BOB_USER)); // Bob signs in on the same tab
    const bob = newWorkspace(services);
    bob.start();
    expect(services.stores.workspace.getState().mode).toBe('browse');
    expect(services.stores.drawing.getState().drawing.points).toHaveLength(0);
    bob.dispose();
  });
});
