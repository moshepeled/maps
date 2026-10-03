/**
 * WorkspaceRoot lifecycle (SPEC section 8.6, UX F-01): the saved view and base layer are in the stores before the map is
 * created, so a production build (no StrictMode double mount) opens the map at the user's last view; and the session
 * dialog's sign-out links go through the C-22 confirmation (UX F-11 step 5).
 */
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ServicesProvider } from '../app/AppContext';
import { createAppServices } from '../app/services';
import { base } from '../base/en';
import { systemScheduler } from '../lib/scheduler';
import { saveViewPreference } from '../state/localDraft';
import { FakeSocket } from '../test/fakeSocket';
import { flush, ME, signedIn } from '../test/workspaceHarness';
import type * as WorkspaceModule from './Workspace';
import { WorkspaceRoot } from './WorkspaceView';

interface SeenView {
  center: { lat: number; lng: number };
  zoom: number;
  choice: string;
}

const probe = vi.hoisted(() => ({ seen: [] as SeenView[] }));

// The real map needs a layout engine; this stand-in records what the map would be created from (MapView reads the
// view stores in a passive effect when it mounts).
vi.mock('../map/MapView', async () => {
  const { useEffect } = await import('react');
  const { useServices } = await import('../app/AppContext');
  return {
    MapView: () => {
      const services = useServices();
      useEffect(() => {
        const view = services.stores.mapView.getState();
        probe.seen.push({ center: { ...view.center }, zoom: view.zoom, choice: view.choice });
      }, [services]);
      return <div data-testid="map" />;
    },
  };
});

// No real socket in jsdom: the page would otherwise dial the jsdom origin.
vi.mock('./Workspace', async (importOriginal) => {
  const original = await importOriginal<typeof WorkspaceModule>();
  return {
    ...original,
    browserEnv: (options: Parameters<typeof original.browserEnv>[0]) => ({
      ...original.browserEnv(options),
      openSocket: () => new FakeSocket(),
    }),
  };
});

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

function services() {
  const app = createAppServices({
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
  app.adopt(signedIn());
  return app;
}

beforeEach(() => {
  localStorage.clear();
  probe.seen.length = 0;
});

afterEach(() => {
  cleanup();
});

describe('WorkspaceRoot', () => {
  it('creates the map at the saved view and base layer, not at the default view', async () => {
    saveViewPreference(ME.id, { center: { lat: 32.0985, lng: 34.8015 }, zoom: 16, choice: 'aerial' });
    const app = services();
    render(
      <ServicesProvider services={app}>
        <WorkspaceRoot />
      </ServicesProvider>,
    );
    await act(async () => {
      await flush();
    });
    expect(probe.seen[0]).toEqual({ center: { lat: 32.0985, lng: 34.8015 }, zoom: 16, choice: 'aerial' });
  });

  it('UX F-11 step 5: "Sign in as someone else" with unsaved work asks first (C-22); Keep working returns', async () => {
    const app = services();
    render(
      <ServicesProvider services={app}>
        <WorkspaceRoot />
      </ServicesProvider>,
    );
    await act(async () => {
      await flush();
    });
    act(() => {
      // Unsaved work under an expired session.
      app.stores.workspace.getState().patch({ mode: 'drawing' });
      app.stores.drawing.getState().setDrawing({
        ...app.stores.drawing.getState().drawing,
        points: [[34.78, 32.08]],
      });
      app.stores.auth.getState().markSessionProblem('expired');
    });
    fireEvent.click(screen.getByRole('button', { name: base.session.switchUser }));
    expect(screen.getByTestId('signout-confirm-dialog')).toBeDefined();
    expect(screen.queryByTestId('session-expired-dialog')).toBeNull();
    expect(app.stores.auth.getState().status).toBe('signed-in');
    fireEvent.click(screen.getByRole('button', { name: base.signout.keep }));
    expect(screen.queryByTestId('signout-confirm-dialog')).toBeNull();
    expect(screen.getByTestId('session-expired-dialog')).toBeDefined();
  });

  it('"Sign out instead" without unsaved work signs out at once', async () => {
    const app = services();
    render(
      <ServicesProvider services={app}>
        <WorkspaceRoot />
      </ServicesProvider>,
    );
    await act(async () => {
      await flush();
    });
    act(() => {
      app.stores.auth.getState().markSessionProblem('expired');
    });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: base.session.signOut }));
      await flush();
    });
    expect(screen.queryByTestId('signout-confirm-dialog')).toBeNull();
    expect(app.stores.auth.getState().status).toBe('signed-out');
  });

  it('does not install the E2E hook in a default build', () => {
    render(
      <ServicesProvider services={services()}>
        <WorkspaceRoot />
      </ServicesProvider>,
    );
    expect((window as { __snapland?: unknown }).__snapland).toBeUndefined();
  });
});
