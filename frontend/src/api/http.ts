/**
 * The SPA's fetch wrapper (SPEC section 8.6 `api/http.ts`): JSON in/out, a 15 s timeout (SPEC section 10.7.3), RFC 9457 problems
 * mapped to `ApiError`, response bodies validated with the shared zod schemas, and a single replay after a
 * single-flight token refresh when the API answers 401 TOKEN_EXPIRED (SPEC section 10.6).
 */
import type { Problem } from '@snapland/shared';
import { ProblemSchema } from '@snapland/shared';
import type { ZodType } from 'zod';

import { FETCH_TIMEOUT_MS } from '../constants/ux';

export type ApiErrorKind = 'http' | 'network' | 'timeout' | 'aborted' | 'invalid-response';

/** Every failure of an API call. `code` is the problem's code, or the kind for transport failures. */
export class ApiError extends Error {
  constructor(
    readonly kind: ApiErrorKind,
    readonly status: number,
    readonly code: string,
    readonly problem: Problem | null,
    /** From the problem's `retryAfterMs`, else the `Retry-After` header (seconds), else null. */
    readonly retryAfterMs: number | null,
    message: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }

  /** Problem extension member (e.g. `current`, `conflictingFields`, `watermark`). */
  extension(name: string): unknown {
    const problem = this.problem as Record<string, unknown> | null;
    return problem?.[name];
  }
}

export function isApiError(error: unknown, code?: string): error is ApiError {
  return error instanceof ApiError && (code === undefined || error.code === code);
}

/**
 * The result of a refresh attempt, as seen by the HTTP client. A `network` failure (transport error, 5xx, rate limit
 * exhausted) carries the refresh's own error, so the request that needed the token can fail with it (UX F-11 step 2).
 */
export type RefreshOutcome =
  | { ok: true }
  | { ok: false; reason: 'expired' | 'revoked' }
  | { ok: false; reason: 'network'; cause: ApiError | null };

export type RefreshFailure = Extract<RefreshOutcome, { ok: false }>;

/**
 * The error a request fails with when its access token could not be refreshed. Only an expired or revoked session is
 * a 401 `SESSION_ENDED` (the session dialog opens and holds the retry). A network / 5xx / rate-limited refresh is NOT
 * a session failure: the request fails with that transport or server error, so writes show the network or storage
 * copy with Retry (and 503s retry automatically) instead of waiting for a dialog that never opens.
 */
export function refreshFailureError(failure: RefreshFailure): ApiError {
  if (failure.reason !== 'network')
    return new ApiError('http', 401, 'SESSION_ENDED', null, null, 'Session ended');
  return failure.cause ?? new ApiError('network', 0, 'NETWORK_ERROR', null, null, 'Network error');
}

export interface TokenSource {
  accessToken(): string | null;
  /** Single-flight (per tab and across tabs) refresh of the access token. */
  refresh(): Promise<RefreshOutcome>;
}

export type QueryValue = string | number | boolean | null | undefined;

export interface RequestOptions<T> {
  method?: 'GET' | 'POST' | 'PATCH' | 'DELETE';
  query?: Readonly<Record<string, QueryValue>>;
  body?: unknown;
  /** Validates the success body; omit for 204 responses. */
  schema?: ZodType<T>;
  /** Send the bearer token and refresh on TOKEN_EXPIRED (default true). */
  auth?: boolean;
  signal?: AbortSignal;
  headers?: Readonly<Record<string, string>>;
}

export interface HttpResponse<T> {
  data: T;
  status: number;
  headers: Headers;
  /** Size of the body in bytes (Content-Length when present). */
  bytes: number;
}

export interface HttpClientOptions {
  baseUrl: string;
  fetch: typeof fetch;
  tokens: TokenSource;
  timeoutMs?: number;
}

export interface HttpClient {
  request<T>(path: string, options?: RequestOptions<T>): Promise<HttpResponse<T>>;
}

/** Parses `Retry-After` (delta-seconds or an HTTP date) into milliseconds. */
export function parseRetryAfter(header: string | null, now: number = Date.now()): number | null {
  if (header === null || header.trim() === '') return null;
  const seconds = Number(header);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const date = Date.parse(header);
  return Number.isNaN(date) ? null : Math.max(0, date - now);
}

function buildUrl(
  baseUrl: string,
  path: string,
  query: Readonly<Record<string, QueryValue>> | undefined,
): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query ?? {})) {
    if (value !== undefined && value !== null) params.set(key, String(value));
  }
  const search = params.toString();
  return `${baseUrl}${path}${search === '' ? '' : `?${search}`}`;
}

async function readProblem(response: Response): Promise<Problem | null> {
  try {
    const parsed = ProblemSchema.safeParse(await response.json());
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

async function toApiError(response: Response): Promise<ApiError> {
  const problem = await readProblem(response);
  const bodyRetry =
    problem !== null && typeof problem['retryAfterMs'] === 'number' ? problem['retryAfterMs'] : null;
  const retryAfterMs = bodyRetry ?? parseRetryAfter(response.headers.get('Retry-After'));
  const code = problem?.code ?? `HTTP_${response.status}`;
  return new ApiError(
    'http',
    response.status,
    code,
    problem,
    retryAfterMs,
    problem?.detail ?? problem?.title ?? code,
  );
}

function combineSignals(timeoutMs: number, signal: AbortSignal | undefined): AbortSignal {
  const timeout = AbortSignal.timeout(timeoutMs);
  return signal === undefined ? timeout : AbortSignal.any([timeout, signal]);
}

export function createHttpClient(options: HttpClientOptions): HttpClient {
  const timeoutMs = options.timeoutMs ?? FETCH_TIMEOUT_MS;

  async function send(path: string, request: RequestOptions<unknown>): Promise<Response> {
    const headers: Record<string, string> = { Accept: 'application/json', ...request.headers };
    if (request.body !== undefined) headers['Content-Type'] = 'application/json';
    const token = request.auth === false ? null : options.tokens.accessToken();
    if (token !== null) headers['Authorization'] = `Bearer ${token}`;
    const init: RequestInit = {
      method: request.method ?? 'GET',
      headers,
      credentials: 'same-origin',
      signal: combineSignals(timeoutMs, request.signal),
    };
    if (request.body !== undefined) init.body = JSON.stringify(request.body);
    try {
      return await options.fetch(buildUrl(options.baseUrl, path, request.query), init);
    } catch (error) {
      if (request.signal?.aborted === true)
        throw new ApiError('aborted', 0, 'ABORTED', null, null, 'Request aborted');
      // Duck-typed: the reason may be a DOMException from another realm (test runners, extensions).
      const isTimeout =
        typeof error === 'object' && error !== null && (error as { name?: unknown }).name === 'TimeoutError';
      throw new ApiError(
        isTimeout ? 'timeout' : 'network',
        0,
        isTimeout ? 'TIMEOUT' : 'NETWORK_ERROR',
        null,
        null,
        isTimeout ? 'The request timed out' : 'Network error',
      );
    }
  }

  async function parse<T>(response: Response, schema: ZodType<T> | undefined): Promise<HttpResponse<T>> {
    const lengthHeader = Number(response.headers.get('Content-Length'));
    if (response.status === 204 || schema === undefined) {
      return { data: undefined as T, status: response.status, headers: response.headers, bytes: 0 };
    }
    const text = await response.text();
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch {
      throw new ApiError(
        'invalid-response',
        response.status,
        'INVALID_RESPONSE',
        null,
        null,
        'Response is not JSON',
      );
    }
    const parsed = schema.safeParse(json);
    if (!parsed.success) {
      throw new ApiError(
        'invalid-response',
        response.status,
        'INVALID_RESPONSE',
        null,
        null,
        parsed.error.message,
      );
    }
    return {
      data: parsed.data,
      status: response.status,
      headers: response.headers,
      bytes: Number.isFinite(lengthHeader) && lengthHeader > 0 ? lengthHeader : text.length,
    };
  }

  return {
    async request<T>(path: string, request: RequestOptions<T> = {}): Promise<HttpResponse<T>> {
      const wantsAuth = request.auth !== false;
      if (wantsAuth && options.tokens.accessToken() === null) {
        // No token in memory (after a reload, or under the session dialog): a request without one could only fail.
        const refreshed = await options.tokens.refresh();
        if (!refreshed.ok) throw refreshFailureError(refreshed);
      }
      let response = await send(path, request);
      if (response.status === 401 && wantsAuth) {
        const error = await toApiError(response);
        if (error.code !== 'TOKEN_EXPIRED') throw error;
        const refreshed = await options.tokens.refresh();
        if (!refreshed.ok) throw refreshFailureError(refreshed);
        response = await send(path, request);
      }
      if (!response.ok && response.status !== 304) throw await toApiError(response);
      return parse(response, request.schema);
    },
  };
}
