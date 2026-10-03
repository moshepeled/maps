import { ProblemSchema } from '@snapland/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { APP_MODULES } from '../../../src/app.js';
import type { InMemoryAuditLogger } from '../../../src/infra/audit/in-memory.js';
import { rateLimitRoute } from '../../../src/infra/http/rate-limits.js';
import { RATE_LIMIT_SCOPES } from '../../../src/infra/redis/keys.js';
import type { RateLimitScope } from '../../../src/infra/redis/keys.js';
import type { AppInstance, AppModule, ModuleFactory } from '../../../src/modules/types.js';
import { createMemoryAudit } from '../../helpers/audit.js';
import { uniqueIp } from '../../helpers/net.js';
import { createTestApp } from '../../helpers/test-app.js';
import type { TestApp } from '../../helpers/test-app.js';
import { bearer, createUser } from '../../helpers/users.js';
import type { TestUser } from '../../helpers/users.js';
import { WsHandshakeError, openWs } from '../../helpers/ws-client.js';
import { waitFor } from '../../helpers/wait-for.js';

const LIMIT = 2;
let testApp: TestApp;
let audit: InMemoryAuditLogger;
let user: TestUser;

/** A module adding an authenticated /api/v1 route WITHOUT an explicit limit: the default `api` scope must apply. */
const probeModule: ModuleFactory = () => ({
  name: 'rate-limit-probe',
  register: (app) => {
    app.get('/api/v1/__probe', { onRequest: [app.authenticate] }, () => ({ ok: true }));
    return Promise.resolve();
  },
});

beforeAll(async () => {
  audit = createMemoryAudit();
  testApp = await createTestApp({
    config: {
      API_RATE_LIMIT_MAX: LIMIT,
      AUTH_RATE_LIMIT_MAX: LIMIT,
      REFRESH_RATE_LIMIT_MAX: LIMIT,
      WS_UPGRADE_RATE_LIMIT_MAX: LIMIT,
    },
    overrides: { audit },
    modules: [...APP_MODULES, probeModule],
    routes: (scope) => {
      for (const ipScope of ['auth', 'refresh'] as const) {
        scope.get(`/limited/${ipScope}`, { config: { rateLimit: rateLimitRoute(ipScope) } }, () => ({
          ok: true,
        }));
      }
      for (const userScope of ['api', 'client_errors'] as const) {
        scope.get(
          `/limited/${userScope}`,
          { onRequest: [scope.authenticate], config: { rateLimit: rateLimitRoute(userScope) } },
          () => ({ ok: true }),
        );
      }
      scope.get('/limited/ws_upgrade', { config: { rateLimit: rateLimitRoute('ws_upgrade') } }, () => ({
        ok: true,
      }));
      scope.get(
        '/ws-probe',
        { websocket: true, config: { rateLimit: rateLimitRoute('ws_upgrade') } },
        (socket) => {
          socket.close(1000, 'probe done');
        },
      );
    },
  });
  user = await createUser(testApp.container);
});

afterAll(async () => {
  await testApp.close();
});

async function hit(scope: RateLimitScope, remoteAddress: string, headers: Record<string, string> = {}) {
  return testApp.app.inject({ method: 'GET', url: `/__test/limited/${scope}`, remoteAddress, headers });
}

function expectRateLimited(
  response: Awaited<ReturnType<typeof hit>>,
  scope: RateLimitScope,
  limit: number,
): void {
  expect(response.statusCode).toBe(429);
  expect(response.headers['ratelimit-limit']).toBe(String(limit));
  expect(response.headers['ratelimit-remaining']).toBe('0');
  expect(Number(response.headers['ratelimit-reset'])).toBeGreaterThan(0);
  expect(Number(response.headers['retry-after'])).toBeGreaterThan(0);
  const problem = ProblemSchema.parse(response.json());
  expect(problem).toMatchObject({ code: 'RATE_LIMITED', scope, limit });
  expect(Number(problem['retryAfterMs'])).toBeGreaterThan(0);
}

describe('generic rate limits (section 6, section 10.1) on test-only routes', () => {
  it.each(['auth', 'refresh', 'ws_upgrade'] as const)(
    '%s: per IP, 429 + RateLimit-* after the limit',
    async (scope) => {
      const ip = uniqueIp();
      for (let i = 0; i < LIMIT; i += 1) {
        const allowed = await hit(scope, ip);
        expect(allowed.statusCode).toBe(200);
        expect(allowed.headers['ratelimit-remaining']).toBe(String(LIMIT - i - 1));
      }
      expectRateLimited(await hit(scope, ip), scope, LIMIT);
      // Another IP has its own bucket.
      expect((await hit(scope, uniqueIp())).statusCode).toBe(200);
    },
  );

  it('api: per user (after authenticate), independent of the IP', async () => {
    for (let i = 0; i < LIMIT; i += 1)
      expect((await hit('api', uniqueIp(), bearer(user))).statusCode).toBe(200);
    expectRateLimited(await hit('api', uniqueIp(), bearer(user)), 'api', LIMIT);
    const other = await createUser(testApp.container);
    expect((await hit('api', uniqueIp(), bearer(other))).statusCode).toBe(200);
  });

  it('client_errors: 30 per minute per user', async () => {
    const reporter = await createUser(testApp.container);
    for (let i = 0; i < 30; i += 1)
      expect((await hit('client_errors', uniqueIp(), bearer(reporter))).statusCode).toBe(200);
    expectRateLimited(await hit('client_errors', uniqueIp(), bearer(reporter)), 'client_errors', 30);
  });

  it('applies the api scope by default to authenticated /api/v1 routes', async () => {
    const caller = await createUser(testApp.container);
    const call = () => testApp.app.inject({ method: 'GET', url: '/api/v1/__probe', headers: bearer(caller) });
    for (let i = 0; i < LIMIT; i += 1) expect((await call()).statusCode).toBe(200);
    const limited = await call();
    expect(limited.statusCode).toBe(429);
    expect(ProblemSchema.parse(limited.json())['scope']).toBe('api');
  });

  it('keeps every limiter key under REDIS_KEY_PREFIX', async () => {
    const { redis, keys } = testApp.container;
    const found = await redis.cmd.keys(`${keys.prefix}rl:*`);
    for (const scope of RATE_LIMIT_SCOPES) {
      expect(found.some((key) => key.startsWith(keys.rateLimit(scope)))).toBe(true);
    }
  });

  it('records each hit as a coalesced ratelimit.hit audit row and counts it', async () => {
    await waitFor(() => audit.find((event) => event.action === 'ratelimit.hit').length >= 5);
    const scopes = new Set(
      audit.find((event) => event.action === 'ratelimit.hit').map((event) => event.details['scope']),
    );
    expect(scopes).toEqual(new Set(RATE_LIMIT_SCOPES));
    const metrics = (await testApp.app.inject({ method: 'GET', url: '/metrics' })).body;
    expect(metrics).toMatch(/snapland_rate_limit_rejections_total\{[^}]*scope="auth"[^}]*\} 1/);
  });

  it('rejects a WebSocket upgrade flood with 429 BEFORE upgrading (onRequest hook)', async () => {
    const baseUrl = await testApp.listen();
    const url = `${baseUrl.replace(/^http/, 'ws')}/__test/ws-probe`;
    // Real sockets cannot pick their source address, and every WebSocket suite of the run upgrades from 127.0.0.1 into
    // the same per-IP bucket (isolation rule 1, section 12.2). The trusted loopback hop (TRUST_PROXY=loopback) lets this test
    // own a fresh client address through X-Forwarded-For, so earlier suites' upgrades cannot exhaust its limit.
    const options = { origin: 'http://localhost:5173', headers: { 'x-forwarded-for': uniqueIp() } };
    for (let i = 0; i < LIMIT; i += 1) {
      const socket = await openWs(url, options);
      await new Promise((resolve) => socket.once('close', resolve));
    }
    const rejected = await openWs(url, options).then(
      () => null,
      (error: unknown) => error,
    );
    expect(rejected).toBeInstanceOf(WsHandshakeError);
    expect((rejected as WsHandshakeError).statusCode).toBe(429);
    expect(ProblemSchema.parse(JSON.parse((rejected as WsHandshakeError).body))['scope']).toBe('ws_upgrade');
  });
});

describe('/api/v1 routes without a rate limit are rejected at registration (section 10.1)', () => {
  function moduleWith(register: AppModule['register']): ModuleFactory {
    return () => ({ name: 'registration-probe', register });
  }

  it.each([
    [
      'no marker and no authentication',
      (app: AppInstance) => app.get('/api/v1/__open', () => ({ ok: true })),
    ],
    [
      'authentication in preHandler only (invisible to the default api scope)',
      (app: AppInstance) =>
        app.get('/api/v1/__late-auth', { preHandler: [app.authenticate] }, () => ({ ok: true })),
    ],
  ])('%s -> the app refuses to build', async (_case, declare) => {
    const building = createTestApp({
      modules: [
        moduleWith((app) => {
          declare(app);
          return Promise.resolve();
        }),
      ],
    });
    await expect(building).rejects.toThrow(/has no rate limit/);
  });

  it('accepts an explicit rateLimit: false (deliberately unlimited public route)', async () => {
    const built = await createTestApp({
      modules: [
        moduleWith((app) => {
          app.get('/api/v1/__public', { config: { rateLimit: false } }, () => ({ ok: true }));
          return Promise.resolve();
        }),
      ],
    });
    try {
      const response = await built.app.inject({ method: 'GET', url: '/api/v1/__public' });
      expect(response.statusCode).toBe(200);
      expect(response.headers['ratelimit-limit']).toBeUndefined();
    } finally {
      await built.close();
    }
  });
});
