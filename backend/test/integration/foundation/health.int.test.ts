import { ReadyResponseSchema } from '@snapland/shared';
import { afterEach, describe, expect, it } from 'vitest';

import { createTcpProxy } from '../../helpers/tcp-proxy.js';
import type { TcpProxy } from '../../helpers/tcp-proxy.js';
import { createTestApp } from '../../helpers/test-app.js';
import type { TestApp } from '../../helpers/test-app.js';
import { waitFor } from '../../helpers/wait-for.js';

const apps: TestApp[] = [];
const proxies: TcpProxy[] = [];

async function track(app: Promise<TestApp>): Promise<TestApp> {
  const created = await app;
  apps.push(created);
  return created;
}

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
  await Promise.all(proxies.splice(0).map((proxy) => proxy.close()));
});

describe('health endpoints (section 10.9)', () => {
  it('GET /health/live answers 200 with the instance id', async () => {
    const { app, container } = await track(createTestApp());
    const response = await app.inject({ method: 'GET', url: '/health/live' });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ status: 'ok', instanceId: container.instanceId });
  });

  it('GET /health/ready is ok with every dependency up and migrations applied', async () => {
    const { app } = await track(createTestApp());
    const response = await app.inject({ method: 'GET', url: '/health/ready' });
    expect(response.statusCode).toBe(200);
    const report = ReadyResponseSchema.parse(response.json());
    expect(report.status).toBe('ok');
    expect(report.checks).toMatchObject({
      database: { status: 'ok' },
      redis: { status: 'ok' },
      migrations: { status: 'ok', pending: 0 },
      shutdown: { status: 'ok' },
      cacheRedis: { status: 'ok' },
    });
    expect(response.headers['cache-control']).toBe('no-store');
  });

  it('is degraded (200) when only the critical Redis is down', async () => {
    const proxy = await createTcpProxy(process.env['REDIS_URL'] ?? '');
    proxies.push(proxy);
    const { app } = await track(createTestApp({ config: { REDIS_URL: proxy.url } }));
    proxy.pause();
    const report = await waitFor(async () => {
      const response = await app.inject({ method: 'GET', url: '/health/ready' });
      const body = ReadyResponseSchema.parse(response.json());
      return body.status === 'degraded' ? { statusCode: response.statusCode, body } : null;
    });
    expect(report.statusCode).toBe(200);
    expect(report.body.checks.redis.status).toBe('fail');
    expect(report.body.checks.redis.error).not.toMatch(/127\.0\.0\.1|localhost|redis:\/\//);
  });

  it('fails (503) when the database is unreachable, without leaking the connection string', async () => {
    const { app } = await track(createTestApp({ config: { DATABASE_URL: 'postgres://x:x@127.0.0.1:1/x' } }));
    const response = await app.inject({ method: 'GET', url: '/health/ready' });
    expect(response.statusCode).toBe(503);
    const report = ReadyResponseSchema.parse(response.json());
    expect(report.status).toBe('fail');
    expect(report.checks.database.status).toBe('fail');
    expect(response.body).not.toContain('x:x@');
  });

  it('reports the L2 cache as disabled when CACHE_REDIS_URL is empty, without changing the status', async () => {
    const { app } = await track(createTestApp({ config: { CACHE_REDIS_URL: '' } }));
    const report = ReadyResponseSchema.parse(
      (await app.inject({ method: 'GET', url: '/health/ready' })).json(),
    );
    expect(report.status).toBe('ok');
    expect(report.checks.cacheRedis).toEqual({ status: 'disabled' });
  });

  it('fails readiness once shutdown has started', async () => {
    const { app } = await track(createTestApp());
    app.lifecycleState.shuttingDown = true;
    const response = await app.inject({ method: 'GET', url: '/health/ready' });
    expect(response.statusCode).toBe(503);
    expect(ReadyResponseSchema.parse(response.json()).checks.shutdown.status).toBe('fail');
  });
});
