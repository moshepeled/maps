import { AreaDtoSchema, AreaMutationResponseSchema } from '@snapland/shared';
import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

import { areaDto, uuid } from '../test/factories';
import { createAreasApi, problemCurrent, restoreConflictAsSuccess } from './areas';
import type { RefreshOutcome, TokenSource } from './http';
import { ApiError, createHttpClient, isApiError, parseRetryAfter } from './http';

function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': status >= 400 ? 'application/problem+json' : 'application/json', ...headers },
  });
}

function problem(status: number, code: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { type: `urn:snapland:problem:${code.toLowerCase()}`, title: code, status, code, ...extra };
}

class Tokens implements TokenSource {
  token: string | null = 'old';
  refreshes = 0;
  outcome: RefreshOutcome = { ok: true };
  accessToken(): string | null {
    return this.token;
  }
  refresh(): Promise<RefreshOutcome> {
    this.refreshes += 1;
    if (this.outcome.ok) this.token = 'new';
    return Promise.resolve(this.outcome);
  }
}

describe('api/http (SPEC section 8.6: problem+json -> ApiError, single-flight refresh)', () => {
  it('parses problem documents into ApiError with code, errors and extensions', async () => {
    const fetch = vi.fn(() =>
      Promise.resolve(
        json(
          422,
          problem(422, 'INVALID_GEOMETRY', {
            errors: [
              {
                path: 'geometry.coordinates.0',
                code: 'SELF_INTERSECTION',
                message: 'x',
                location: [34.785, 32.085],
              },
            ],
          }),
        ),
      ),
    );
    const http = createHttpClient({ baseUrl: '/api/v1', fetch, tokens: new Tokens() });
    const error = await http
      .request('/areas', { method: 'POST', body: {} })
      .catch((caught: unknown) => caught);
    expect(isApiError(error, 'INVALID_GEOMETRY')).toBe(true);
    if (!(error instanceof ApiError)) return;
    expect(error.status).toBe(422);
    expect(error.problem?.errors?.[0]?.location).toEqual([34.785, 32.085]);
    expect(error.kind).toBe('http');
  });

  it('retryAfterMs in the body wins over the Retry-After header; the header is the fallback', async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(
        json(429, problem(429, 'RATE_LIMITED', { retryAfterMs: 5000 }), { 'Retry-After': '30' }),
      )
      .mockResolvedValueOnce(json(503, problem(503, 'DEPENDENCY_UNAVAILABLE'), { 'Retry-After': '5' }))
      .mockResolvedValueOnce(new Response('oops', { status: 500 }));
    const http = createHttpClient({ baseUrl: '', fetch, tokens: new Tokens() });
    const first = await http.request('/x').catch((caught: unknown) => caught);
    const second = await http.request('/x').catch((caught: unknown) => caught);
    const third = await http.request('/x').catch((caught: unknown) => caught);
    expect(first instanceof ApiError && first.retryAfterMs).toBe(5000);
    expect(second instanceof ApiError && second.retryAfterMs).toBe(5000);
    expect(third instanceof ApiError && third.code).toBe('HTTP_500');
    expect(parseRetryAfter(null)).toBeNull();
    expect(
      parseRetryAfter('Wed, 21 Oct 2015 07:28:10 GMT', Date.parse('Wed, 21 Oct 2015 07:28:00 GMT')),
    ).toBe(10_000);
    expect(parseRetryAfter('soon')).toBeNull();
  });

  it('TOKEN_EXPIRED -> one refresh shared by concurrent requests, each replayed once with the new token', async () => {
    const tokens = new Tokens();
    let refreshCalls = 0;
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => (release = resolve));
    let inFlight: Promise<RefreshOutcome> | null = null;
    tokens.refresh = () => {
      inFlight ??= (async () => {
        refreshCalls += 1;
        await gate;
        tokens.token = 'new';
        return { ok: true } as const;
      })();
      return inFlight;
    };
    const fetch = vi.fn((_url: string, init?: RequestInit) => {
      const auth = new Headers(init?.headers).get('Authorization');
      return Promise.resolve(
        auth === 'Bearer new' ? json(200, { ok: true }) : json(401, problem(401, 'TOKEN_EXPIRED')),
      );
    });
    const http = createHttpClient({ baseUrl: '', fetch: fetch as typeof globalThis.fetch, tokens });
    const schema = z.object({ ok: z.boolean() });
    const pending = [http.request('/a', { schema }), http.request('/b', { schema })];
    await new Promise((resolve) => setTimeout(resolve, 0));
    release();
    const results = await Promise.all(pending);
    expect(results.map((response) => response.data.ok)).toEqual([true, true]);
    expect(refreshCalls).toBe(1);
    expect(fetch).toHaveBeenCalledTimes(4);
  });

  it('a failed refresh ends the session; TOKEN_INVALID is not refreshed', async () => {
    const tokens = new Tokens();
    tokens.outcome = { ok: false, reason: 'revoked' };
    const fetch = vi.fn(() => Promise.resolve(json(401, problem(401, 'TOKEN_EXPIRED'))));
    const http = createHttpClient({ baseUrl: '', fetch, tokens });
    const error = await http.request('/x').catch((caught: unknown) => caught);
    expect(error instanceof ApiError && error.code).toBe('SESSION_ENDED');
    const invalid = createHttpClient({
      baseUrl: '',
      fetch: () => Promise.resolve(json(401, problem(401, 'TOKEN_INVALID'))),
      tokens: new Tokens(),
    });
    const second = await invalid.request('/x').catch((caught: unknown) => caught);
    expect(second instanceof ApiError && second.code).toBe('TOKEN_INVALID');
  });

  it('UX F-11 step 2: a refresh failing for a network / 5xx reason is not a session failure', async () => {
    const expired = (): Promise<Response> => Promise.resolve(json(401, problem(401, 'TOKEN_EXPIRED')));
    const unavailable = new ApiError('http', 503, 'DEPENDENCY_UNAVAILABLE', null, 5000, 'down');
    const tokens = new Tokens();
    tokens.outcome = { ok: false, reason: 'network', cause: unavailable };
    const http = createHttpClient({ baseUrl: '', fetch: expired, tokens });
    // The refresh's own 503 surfaces (writes then retry it as "storage unavailable"), never a 401.
    expect(await http.request('/x', { method: 'POST' }).catch((caught: unknown) => caught)).toBe(unavailable);

    const unreachable = new Tokens();
    unreachable.outcome = { ok: false, reason: 'network', cause: null };
    const offline = createHttpClient({ baseUrl: '', fetch: expired, tokens: unreachable });
    const error = await offline.request('/x').catch((caught: unknown) => caught);
    expect(isApiError(error) ? [error.kind, error.status, error.code] : null).toEqual([
      'network',
      0,
      'NETWORK_ERROR',
    ]);
  });

  it('without a token, a failed refresh fails the request without sending it', async () => {
    const tokens = new Tokens();
    tokens.token = null;
    tokens.outcome = { ok: false, reason: 'expired' };
    const fetch = vi.fn(() => Promise.resolve(json(200, { ok: true })));
    const http = createHttpClient({ baseUrl: '', fetch, tokens });
    const error = await http.request('/x').catch((caught: unknown) => caught);
    expect(isApiError(error, 'SESSION_ENDED') && error.status).toBe(401);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('refreshes first when no access token is in memory (after a reload)', async () => {
    const tokens = new Tokens();
    tokens.token = null;
    const fetch = vi.fn(() => Promise.resolve(json(200, { ok: true })));
    const http = createHttpClient({ baseUrl: '', fetch, tokens });
    await http.request('/x', { schema: z.object({ ok: z.boolean() }) });
    expect(tokens.refreshes).toBe(1);
  });

  it('network errors, timeouts, aborts and invalid bodies map to their kinds', async () => {
    const network = createHttpClient({
      baseUrl: '',
      fetch: () => Promise.reject(new TypeError('Failed to fetch')),
      tokens: new Tokens(),
    });
    const networkError = await network.request('/x').catch((caught: unknown) => caught);
    expect(networkError instanceof ApiError && networkError.kind).toBe('network');

    const hanging: typeof globalThis.fetch = (_url, init) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => {
          reject(init.signal?.reason as Error);
        });
      });
    const slow = createHttpClient({ baseUrl: '', fetch: hanging, tokens: new Tokens(), timeoutMs: 20 });
    const timeout = await slow.request('/x').catch((caught: unknown) => caught);
    expect(timeout instanceof ApiError && timeout.kind).toBe('timeout');
    const controller = new AbortController();
    const aborted = slow.request('/x', { signal: controller.signal }).catch((caught: unknown) => caught);
    controller.abort();
    const abortedError = await aborted;
    expect(abortedError instanceof ApiError && abortedError.kind).toBe('aborted');

    const bad = createHttpClient({
      baseUrl: '',
      fetch: () => Promise.resolve(json(200, { nope: 1 })),
      tokens: new Tokens(),
    });
    const invalid = await bad.request('/x', { schema: AreaDtoSchema }).catch((caught: unknown) => caught);
    expect(invalid instanceof ApiError && invalid.kind).toBe('invalid-response');
    const notJson = createHttpClient({
      baseUrl: '',
      fetch: () => Promise.resolve(new Response('<html>', { status: 200 })),
      tokens: new Tokens(),
    });
    const html = await notJson.request('/x', { schema: AreaDtoSchema }).catch((caught: unknown) => caught);
    expect(html instanceof ApiError && html.code).toBe('INVALID_RESPONSE');
  });

  it('builds query strings and sends JSON bodies with the bearer token', async () => {
    const fetch = vi.fn((_url: string, _init?: RequestInit) =>
      Promise.resolve(new Response(null, { status: 204 })),
    );
    const http = createHttpClient({
      baseUrl: '/api/v1',
      fetch: fetch as typeof globalThis.fetch,
      tokens: new Tokens(),
    });
    await http.request('/areas/x', {
      method: 'DELETE',
      query: { baseVersion: 3, skip: undefined, flag: true },
    });
    expect(fetch.mock.calls[0]?.[0]).toBe('/api/v1/areas/x?baseVersion=3&flag=true');
    expect(new Headers(fetch.mock.calls[0]?.[1]?.headers).get('Authorization')).toBe('Bearer old');
  });
});

describe('restore conflict read as success (SG-15, UX F-06 step 3)', () => {
  const id = uuid(77);

  it('AREA_NOT_DELETED with current live at baseVersion + 1 is a success', () => {
    const error = new ApiError(
      'http',
      409,
      'AREA_NOT_DELETED',
      problem(409, 'AREA_NOT_DELETED', { current: areaDto({ id, version: 6 }) }) as never,
      null,
      'x',
    );
    const success = restoreConflictAsSuccess(error, 5);
    expect(success?.area.version).toBe(6);
    expect(restoreConflictAsSuccess(error, 3)).toBeNull();
    expect(problemCurrent(error)?.id).toBe(id);
    expect(restoreConflictAsSuccess(new Error('x'), 5)).toBeNull();
  });

  it('api.restore resolves with the current area when a retried restore already succeeded', async () => {
    const fetch = vi.fn(() =>
      Promise.resolve(json(409, problem(409, 'AREA_NOT_DELETED', { current: areaDto({ id, version: 6 }) }))),
    );
    const api = createAreasApi(createHttpClient({ baseUrl: '', fetch, tokens: new Tokens() }));
    const response = await api.restore(id, 5);
    expect(AreaMutationResponseSchema.safeParse(response).success).toBe(true);
    expect(response.area.version).toBe(6);
    await expect(api.restore(id, 2)).rejects.toBeInstanceOf(ApiError);
  });

  it('the change feed maps 410 to FeedExpiredError', async () => {
    const fetch = vi.fn(() =>
      Promise.resolve(json(410, problem(410, 'CHANGE_FEED_EXPIRED', { watermark: 1200 }))),
    );
    const api = createAreasApi(createHttpClient({ baseUrl: '', fetch, tokens: new Tokens() }));
    await expect(api.changes({ since: 1, limit: 500 }, new AbortController().signal)).rejects.toThrow(
      'Change feed expired',
    );
  });
});
