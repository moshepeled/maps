// QA evidence (T5 review round 1): a browser `offline` -> `online` blip while the WebSocket itself stays open. The
// `offline` state makes the handlers call `draft.handleDisconnected()` (claimed = false); `online` puts the state back
// to `live` without a new `welcome`, so nothing re-claims the draft and live sharing silently stops until the server
// idle-expires it (120 s). Added by the qa-expert.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createAppServices } from '../app/services';
import { systemScheduler } from '../lib/scheduler';
import { FakeSocket } from '../test/fakeSocket';
import { flush, signedIn } from '../test/workspaceHarness';
import { Workspace } from './Workspace';

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

beforeEach(() => {
  vi.useFakeTimers();
  localStorage.clear();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('QA: offline/online blip with the socket still open (SPEC section 7.12, UX F-13)', () => {
  it('live sharing of my draft resumes after the blip', async () => {
    const services = createAppServices({
      fetch: (input) => {
        const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
        if (url.endsWith('/auth/ws-ticket'))
          return Promise.resolve(
            json(201, { ticket: 'a'.repeat(43), expiresAt: new Date(Date.now() + 30_000).toISOString() }),
          );
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
    });
    workspace.start();
    await flush();
    await vi.advanceTimersByTimeAsync(0);
    const socket = sockets[0];
    if (socket === undefined) throw new Error('no socket');
    socket.open();
    socket.welcome();

    workspace.drawing.start('pointer');
    workspace.drawing.place([34.78, 32.08]);
    const start = socket.sentOfType('draft.start')[0];
    socket.receive({ type: 'ack', ref: start?.ref, data: { drawActionsRemaining: 49 } });
    await flush();
    workspace.drawing.place([34.79, 32.08]);
    await vi.advanceTimersByTimeAsync(200);
    const before = socket.sentOfType('draft.update').length;
    expect(before).toBeGreaterThan(0);

    globalThis.dispatchEvent(new Event('offline'));
    globalThis.dispatchEvent(new Event('online'));
    expect(services.stores.connection.getState().state).toBe('live');
    expect(socket.closedWith).toBeNull(); // the same socket is still open

    workspace.drawing.place([34.79, 32.09]);
    await vi.advanceTimersByTimeAsync(200);
    // Expected: my new point reaches collaborators (an update, or a resume/start followed by one).
    expect(
      socket.sentOfType('draft.update').length + socket.sentOfType('draft.start').length,
    ).toBeGreaterThan(before + 1);
    workspace.dispose();
  });
});
