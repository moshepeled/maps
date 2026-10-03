// Regression (QA-T5-03, T5 review round 1): UX F-11 step 2 - a network / 5xx failure of the token refresh is NOT a
// session failure. It used to surface as `401 NETWORK_ERROR`, and every write flow held any 401 for a session dialog
// that never opens, so the save failed silently. Now the request fails with the refresh's own transport / server
// error, and only a session-ended failure (or a 401 while the dialog is up) holds the retry.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ApiError, createHttpClient, isApiError } from '../api/http';
import { apiProblem, createHarness, flush } from '../test/workspaceHarness';
import { DrawingFlow } from './drawingFlow';

beforeEach(() => {
  vi.useFakeTimers();
  localStorage.clear();
});

afterEach(() => {
  vi.useRealTimers();
});

function tokenExpired(): Promise<Response> {
  return Promise.resolve(
    new Response(JSON.stringify({ type: 'x', title: 'x', status: 401, code: 'TOKEN_EXPIRED' }), {
      status: 401,
      headers: { 'Content-Type': 'application/problem+json' },
    }),
  );
}

function namingFlow() {
  const h = createHarness();
  const held: (() => void)[] = [];
  const flow = new DrawingFlow(h.ctx, {
    onSaved: () => undefined,
    retryAfterSignIn: (action) => {
      held.push(action);
    },
  });
  flow.start('pointer');
  flow.place([34.78, 32.08]);
  flow.place([34.79, 32.08]);
  flow.place([34.79, 32.09]);
  expect(flow.finish()).toBe(true);
  h.ctx.stores.drawing.getState().patchNaming({ name: 'Field' });
  return { h, flow, held };
}

async function settle(): Promise<void> {
  await flush();
  await vi.advanceTimersByTimeAsync(0);
  await flush();
}

describe('QA: refresh failing for a network reason during a save (UX F-11 step 2)', () => {
  it('the http client reports a transport error, not a 401', async () => {
    const http = createHttpClient({
      baseUrl: '/api/v1',
      fetch: tokenExpired,
      tokens: {
        accessToken: () => 'old',
        refresh: () => Promise.resolve({ ok: false, reason: 'network', cause: null }),
      },
    });
    const error: unknown = await http
      .request('/areas', { method: 'POST', body: {} })
      .catch((e: unknown) => e);
    expect(isApiError(error) ? [error.kind, error.status, error.code] : null).toEqual([
      'network',
      0,
      'NETWORK_ERROR',
    ]);
  });

  it('a network failure of the refresh shows the network toast with Retry; nothing is held', async () => {
    const { h, flow, held } = namingFlow();
    h.api.create.mockImplementation(() =>
      Promise.reject(new ApiError('network', 0, 'NETWORK_ERROR', null, null, 'Network error')),
    );
    flow.save();
    await settle();
    expect(held).toHaveLength(0);
    const toast = h.ctx.stores.toasts.getState().toasts.find((candidate) => candidate.kind === 'error');
    expect(toast?.code).toBe('toast.saveFailedNetwork');
    expect(toast?.action?.kind).toBe('retry');
  });

  it('a 401 with no session dialog up (e.g. TOKEN_INVALID) is an ordinary failure, not a silent hold', async () => {
    const { h, flow, held } = namingFlow();
    h.api.create.mockImplementation(() => Promise.reject(apiProblem(401, 'TOKEN_INVALID')));
    flow.save();
    await settle();
    expect(h.ctx.stores.auth.getState().sessionProblem).toBeNull();
    expect(held).toHaveLength(0);
    expect(h.ctx.stores.toasts.getState().toasts.filter((toast) => toast.kind === 'error')).toHaveLength(1);
  });

  it('a 401 while the session dialog is up is held for the retry after signing in again', async () => {
    const { h, flow, held } = namingFlow();
    h.ctx.stores.auth.getState().markSessionProblem('expired');
    h.api.create.mockImplementation(() => Promise.reject(apiProblem(401, 'TOKEN_EXPIRED')));
    flow.save();
    await settle();
    expect(held).toHaveLength(1);
    expect(h.ctx.stores.toasts.getState().toasts.filter((toast) => toast.kind === 'error')).toHaveLength(0);
  });

  it('UX-AC-92: a 503 from the refresh runs the storage retries of the save', async () => {
    const { h, flow, held } = namingFlow();
    h.api.create.mockImplementation(() =>
      Promise.reject(apiProblem(503, 'DEPENDENCY_UNAVAILABLE', {}, 5000)),
    );
    flow.save();
    await settle();
    expect(held).toHaveLength(0);
    expect(
      h.ctx.stores.toasts.getState().toasts.some((toast) => toast.code === 'toast.storageUnavailable'),
    ).toBe(true);
  });
});
