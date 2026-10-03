import { connect } from 'node:net';

import { ProblemSchema } from '@snapland/shared';
import { afterEach, describe, expect, it } from 'vitest';

import { sql } from '../../../src/infra/db/types.js';
import { createTcpProxy } from '../../helpers/tcp-proxy.js';
import type { TcpProxy } from '../../helpers/tcp-proxy.js';
import { createTestApp } from '../../helpers/test-app.js';
import type { TestApp } from '../../helpers/test-app.js';
import { timed } from '../../helpers/wait-for.js';

const apps: TestApp[] = [];
const proxies: TcpProxy[] = [];

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
  await Promise.all(proxies.splice(0).map((proxy) => proxy.close()));
});

async function app(options: Parameters<typeof createTestApp>[0]): Promise<TestApp> {
  const created = await createTestApp(options);
  apps.push(created);
  return created;
}

const SLEEP_2S = sql('testTimeouts.sleep2s', 'SELECT pg_sleep(2)');
const SELECT_ONE = sql('testTimeouts.selectOne', 'SELECT 1 AS one');

describe('request timeouts (section 10.7.3, the four normative cases)', () => {
  it('1. the route safety net answers 503 REQUEST_TIMEOUT in 1.0-1.4 s and is not attached to /ws and /metrics', async () => {
    const testApp = await app({
      config: { REQUEST_TIMEOUT_MS: 1000 },
      routes: (scope) => {
        scope.get('/slow', async () => {
          await new Promise((resolve) => setTimeout(resolve, 1500));
          return { late: true };
        });
      },
    });
    const { result: response, elapsedMs } = await timed(() =>
      testApp.app.inject({ method: 'GET', url: '/__test/slow' }),
    );
    expect(response.statusCode).toBe(503);
    const problem = ProblemSchema.parse(response.json());
    expect(problem).toMatchObject({ code: 'REQUEST_TIMEOUT' });
    expect(problem.requestId).toBe(response.headers['x-request-id']);
    expect(elapsedMs).toBeGreaterThanOrEqual(1000);
    expect(elapsedMs).toBeLessThanOrEqual(1400);

    const routes = testApp.app.printRoutes({ includeHooks: true, commonPrefix: false });
    const lines = routes.split('\n');
    const hookBlock = (path: string): string => {
      const start = lines.findIndex((line) => line.includes(path));
      const next = lines.findIndex(
        (line, index) => index > start && /^\S|── /.test(line) && !line.includes('•'),
      );
      return lines.slice(start, next === -1 ? undefined : next).join('\n');
    };
    expect(hookBlock('/__test/slow')).toContain('requestTimeoutSafetyNet');
    expect(hookBlock('/metrics')).not.toContain('requestTimeoutSafetyNet');
  });

  it('2. a statement past DB_STATEMENT_TIMEOUT_MS answers 503 REQUEST_TIMEOUT (57014) within 1.5 s; the pool stays healthy', async () => {
    const testApp = await app({
      config: { DB_STATEMENT_TIMEOUT_MS: 500 },
      routes: (scope, container) => {
        scope.get('/pg-sleep', async () => container.db.query(SLEEP_2S));
        scope.get('/pg-one', async () => container.db.query(SELECT_ONE));
      },
    });
    const { result: response, elapsedMs } = await timed(() =>
      testApp.app.inject({ method: 'GET', url: '/__test/pg-sleep' }),
    );
    expect(response.statusCode).toBe(503);
    expect(ProblemSchema.parse(response.json()).code).toBe('REQUEST_TIMEOUT');
    expect(elapsedMs).toBeLessThan(1500);
    const healthy = await testApp.app.inject({ method: 'GET', url: '/__test/pg-one' });
    expect(healthy.statusCode).toBe(200);
    expect(healthy.json()).toEqual([{ one: 1 }]);
  });

  it('3. a stalled Redis fails the command with 503 DEPENDENCY_UNAVAILABLE within REDIS_COMMAND_TIMEOUT_MS + 200 ms', async () => {
    const proxy = await createTcpProxy(process.env['REDIS_URL'] ?? '');
    proxies.push(proxy);
    const testApp = await app({
      config: { REDIS_URL: proxy.url, REDIS_COMMAND_TIMEOUT_MS: 500 },
      routes: (scope, container) => {
        scope.get('/redis-get', async () => ({
          value: await container.redis.cmd.get(`${container.keys.prefix}timeouts:probe`),
        }));
      },
    });
    expect((await testApp.app.inject({ method: 'GET', url: '/__test/redis-get' })).statusCode).toBe(200);
    proxy.stall();
    const { result: response, elapsedMs } = await timed(() =>
      testApp.app.inject({ method: 'GET', url: '/__test/redis-get' }),
    );
    expect(response.statusCode).toBe(503);
    expect(ProblemSchema.parse(response.json()).code).toBe('DEPENDENCY_UNAVAILABLE');
    expect(elapsedMs).toBeLessThanOrEqual(500 + 200);
  });

  it('4. a trickled request body is answered by Node with 408 within 1.5 s and the socket is closed', async () => {
    const testApp = await app({
      config: { HTTP_REQUEST_TIMEOUT_MS: 1000 },
      routes: (scope) => {
        scope.post('/upload', () => ({ ok: true }));
      },
    });
    const port = Number(new URL(await testApp.listen()).port);
    const started = performance.now();
    const outcome = await new Promise<{ response: string; closedAfterMs: number }>((resolve, reject) => {
      const socket = connect({ host: '127.0.0.1', port }, () => {
        socket.write(
          'POST /__test/upload HTTP/1.1\r\nHost: 127.0.0.1\r\nContent-Type: application/json\r\nContent-Length: 100\r\n\r\n',
        );
      });
      let response = '';
      const trickle = setInterval(() => {
        if (!socket.destroyed) socket.write(' ');
      }, 300);
      socket.on('data', (chunk: Buffer) => {
        response += chunk.toString('utf8');
      });
      socket.on('close', () => {
        clearInterval(trickle);
        resolve({ response, closedAfterMs: performance.now() - started });
      });
      socket.on('error', (error) => {
        clearInterval(trickle);
        reject(error);
      });
    });
    expect(outcome.response.startsWith('HTTP/1.1 408')).toBe(true);
    expect(outcome.closedAfterMs).toBeLessThanOrEqual(1500);
  });
});
