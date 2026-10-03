/**
 * Generic HTTP rate limits (SPEC section 6, section 10.1) on @fastify/rate-limit with a Redis store whose keys live under
 * REDIS_KEY_PREFIX (`<prefix>rl:<scope>:<key>`, one bucket per scope, shared by every route of the scope). IETF
 * `RateLimit-*` headers, `skipOnError` (Redis down -> allow), problem+json 429s, and every hit counted and audited through
 * the coalescer. Routes opt in with `config: { rateLimit: rateLimitRoute('<scope>') }`; the `api` scope is applied
 * automatically to every `/api/v1` route authenticated at route level (`onRequest: [app.authenticate]`, keyed by user
 * after it). Any other `/api/v1` route must carry a marker or an explicit `rateLimit: false`, or the app refuses to build.
 */
import rateLimit from '@fastify/rate-limit';
import type { FastifyRateLimitStore, RateLimitOptions } from '@fastify/rate-limit';
import { RATE_LIMITS } from '@snapland/shared';
import type { FastifyInstance, FastifyRequest, RouteOptions } from 'fastify';
import type { Redis } from 'ioredis';

import type { AppConfig } from '../../config/env.js';
import type { AuditCoalescer } from '../audit/types.js';
import type { Metrics } from '../metrics/metrics.js';
import { RATE_LIMIT_SCOPES } from '../redis/keys.js';
import type { RateLimitScope, RedisKeys } from '../redis/keys.js';
import { LuaScript } from '../redis/lua.js';
import { RateLimitedError } from './errors.js';
import { normalizeIp, normalizeUserAgent } from './request-context.js';

/** Route-level marker; the onRoute hook below expands it into the full plugin options. */
export type RateLimitRouteConfig = RateLimitOptions & { scope: RateLimitScope };

const WINDOW_MS = 60_000;

/** Scopes keyed by the authenticated user run after `authenticate` (preHandler); IP scopes run first (onRequest). */
const USER_KEYED: ReadonlySet<RateLimitScope> = new Set(['api', 'client_errors']);

/** `config: { rateLimit: rateLimitRoute('auth') }` on a route. */
export function rateLimitRoute(scope: RateLimitScope): RateLimitRouteConfig {
  return { scope };
}

function maxForScope(scope: RateLimitScope, config: AppConfig): number {
  switch (scope) {
    case 'api':
      return config.API_RATE_LIMIT_MAX;
    case 'auth':
      return config.AUTH_RATE_LIMIT_MAX;
    case 'refresh':
      return config.REFRESH_RATE_LIMIT_MAX;
    case 'client_errors':
      return RATE_LIMITS.clientErrorsPerMinute;
    case 'ws_upgrade':
      return config.WS_UPGRADE_RATE_LIMIT_MAX;
  }
}

function isScope(value: unknown): value is RateLimitScope {
  return typeof value === 'string' && (RATE_LIMIT_SCOPES as readonly string[]).includes(value);
}

function scopeOf(value: unknown): RateLimitScope | null {
  if (typeof value !== 'object' || value === null || !('scope' in value)) return null;
  return isScope(value.scope) ? value.scope : null;
}

/** Client identity of a request: the user for user-keyed scopes, else the (proxy-resolved) IP. */
function clientKey(request: FastifyRequest, scope: RateLimitScope): string {
  if (USER_KEYED.has(scope) && request.auth !== null) return `u:${request.auth.userId}`;
  return `ip:${request.ip}`;
}

/** INCR + PEXPIRE on the first hit of a window; returns [current, ttlMs] (the plugin's fixed-window semantics). */
const FIXED_WINDOW = new LuaScript(`
local current = redis.call('INCR', KEYS[1])
if current == 1 then
  redis.call('PEXPIRE', KEYS[1], ARGV[1])
  return {current, tonumber(ARGV[1])}
end
local ttl = redis.call('PTTL', KEYS[1])
if ttl < 0 then
  redis.call('PEXPIRE', KEYS[1], ARGV[1])
  ttl = tonumber(ARGV[1])
end
return {current, ttl}
`);

/** A store class bound to one Redis client; `child()` binds the route's scope (its key namespace). */
function scopedStoreClass(redis: Redis, keys: RedisKeys) {
  return class ScopedRedisStore implements FastifyRateLimitStore {
    readonly #namespace: string;

    constructor(options: unknown) {
      this.#namespace = keys.rateLimit(scopeOf(options) ?? 'api');
    }

    incr(
      key: string,
      callback: (error: Error | null, result?: { current: number; ttl: number }) => void,
      timeWindow: number,
    ): void {
      FIXED_WINDOW.run(redis, [`${this.#namespace}${key}`], [timeWindow]).then(
        (result) => {
          const [current, ttl]: unknown[] = Array.isArray(result) ? (result as unknown[]) : [];
          callback(null, { current: Number(current), ttl: Number(ttl) });
        },
        (error: unknown) => {
          callback(error instanceof Error ? error : new Error(String(error)));
        },
      );
    }

    child(routeOptions: unknown): FastifyRateLimitStore {
      return new ScopedRedisStore(routeOptions);
    }
  };
}

const API_PREFIX = '/api/v1/';

/**
 * Only a route-level `onRequest: [app.authenticate]` is recognised: authentication added in `preHandler` or through a
 * plugin-level `addHook` is invisible here, so such routes are rejected below instead of silently going unlimited.
 */
function isAuthenticatedRoute(route: RouteOptions, authenticate: unknown): boolean {
  const hooks = route.onRequest;
  if (hooks === undefined) return false;
  return Array.isArray(hooks) ? hooks.includes(authenticate as never) : hooks === authenticate;
}

function describeRoute(route: RouteOptions): string {
  const methods = Array.isArray(route.method) ? route.method.join(',') : route.method;
  return `${methods} ${route.url}`;
}

/** Fail-fast registration error for an /api/v1 route that would otherwise run without any rate limit. */
function unlimitedApiRouteError(route: RouteOptions): Error {
  return new Error(
    `${describeRoute(route)} has no rate limit. Every /api/v1 route must declare config.rateLimit = ` +
      "rateLimitRoute('<scope>'), or config.rateLimit = false for a deliberately unlimited public route, or " +
      "authenticate at route level with onRequest: [app.authenticate] (default 'api' scope, SPEC section 10.1).",
  );
}

export interface RateLimitDeps {
  config: AppConfig;
  redis: Redis;
  keys: RedisKeys;
  metrics: Metrics;
  auditCoalescer: AuditCoalescer;
  /** `app.authenticate` (to recognise authenticated routes for the default `api` scope). */
  authenticate: unknown;
}

/**
 * Expands `rateLimitRoute(scope)` markers and applies the default `api` scope to route-level-authenticated /api/v1
 * routes. An /api/v1 route with neither is rejected at registration (the app fails to build) rather than served
 * unlimited. Must be added before the plugin.
 */
function expandRouteLimits(app: FastifyInstance, deps: RateLimitDeps): void {
  app.addHook('onRoute', (route) => {
    const configured = route.config?.rateLimit;
    if (configured === false) return;
    let scope = scopeOf(configured);
    if (scope === null && configured === undefined && route.url.startsWith(API_PREFIX)) {
      if (!isAuthenticatedRoute(route, deps.authenticate)) throw unlimitedApiRouteError(route);
      scope = 'api';
    }
    if (scope === null) return;
    const expanded: RateLimitRouteConfig = {
      ...(typeof configured === 'object' ? configured : {}),
      scope,
      max: maxForScope(scope, deps.config),
      timeWindow: WINDOW_MS,
      hook: USER_KEYED.has(scope) ? 'preHandler' : 'onRequest',
      keyGenerator: (request) => clientKey(request, scope),
    };
    route.config = { ...route.config, rateLimit: expanded };
  });
}

function onExceeded(deps: RateLimitDeps) {
  return (request: FastifyRequest): void => {
    const scope = scopeOf(request.routeOptions.config.rateLimit) ?? 'api';
    const transport = scope === 'ws_upgrade' ? 'ws' : 'rest';
    deps.metrics.rateLimitRejectionsTotal.inc({ scope, transport });
    const userId = request.auth?.userId ?? null;
    deps.auditCoalescer.record(`ratelimit:${scope}:${userId ?? request.ip}`, {
      action: 'ratelimit.hit',
      outcome: 'denied',
      actorId: userId,
      sessionId: request.auth?.sessionId ?? null,
      targetType: userId === null ? null : 'user',
      targetId: userId,
      requestId: request.id,
      ip: normalizeIp(request.ip),
      userAgent: normalizeUserAgent(request.headers['user-agent']),
      details: {
        scope,
        transport,
        limit: maxForScope(scope, deps.config),
        route: request.routeOptions.url ?? null,
      },
    });
  };
}

export async function registerRateLimiting(app: FastifyInstance, deps: RateLimitDeps): Promise<void> {
  expandRouteLimits(app, deps);
  await app.register(rateLimit, {
    global: false,
    store: scopedStoreClass(deps.redis, deps.keys),
    skipOnError: true,
    enableDraftSpec: true,
    timeWindow: WINDOW_MS,
    onExceeded: onExceeded(deps),
    errorResponseBuilder: (request, context) =>
      new RateLimitedError({
        scope: scopeOf(request.routeOptions.config.rateLimit) ?? 'api',
        limit: context.max,
        retryAfterMs: context.ttl,
      }),
  });
}
