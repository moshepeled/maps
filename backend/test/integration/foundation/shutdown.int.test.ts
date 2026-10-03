/**
 * Graceful shutdown (SPEC section 10.12): the ordered `gracefulShutdown` sequence, and the process entry itself exiting 1
 * (instead of hanging on open sockets) when listen fails.
 */
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import type { AddressInfo, Server } from 'node:net';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { APP_MODULES } from '../../../src/app.js';
import { gracefulShutdown } from '../../../src/infra/shutdown.js';
import type { Container } from '../../../src/container.js';
import type { ModuleFactory } from '../../../src/modules/types.js';
import { createTestApp, nextInstanceId } from '../../helpers/test-app.js';
import type { TestApp } from '../../helpers/test-app.js';
import { waitFor } from '../../helpers/wait-for.js';
import { openWs } from '../../helpers/ws-client.js';

const BACKEND_DIR = fileURLToPath(new URL('../../../', import.meta.url));
const GOING_AWAY = 1001;

const apps: TestApp[] = [];

afterEach(async () => {
  // Tests that shut an app down themselves leave it closed; container.close() is idempotent, app.close() is not needed.
  await Promise.all(apps.splice(0).map((testApp) => testApp.container.close()));
});

async function track(created: Promise<TestApp>): Promise<TestApp> {
  const testApp = await created;
  apps.push(testApp);
  return testApp;
}

/** A module that records its lifecycle calls into `events`. */
function recordingModule(name: string, events: string[]): ModuleFactory {
  return () => ({
    name,
    register: () => Promise.resolve(),
    start: () => {
      events.push(`start:${name}`);
      return Promise.resolve();
    },
    stop: () => {
      events.push(`stop:${name}`);
      return Promise.resolve();
    },
  });
}

/** quit() resolves on the server's reply; the client reaches 'end' when its socket has closed. */
async function redisEnded(container: Container): Promise<void> {
  await waitFor(() => container.redis.cmd.status === 'end' && container.redis.sub.status === 'end', {
    description: 'Redis clients closed',
  });
}

function socketUrl(baseUrl: string, path: string): string {
  return `${baseUrl.replace(/^http/, 'ws')}/__test${path}`;
}

describe('gracefulShutdown (section 10.12)', () => {
  it('marks not-ready, closes sockets with 1001, drains HTTP, stops modules in reverse, then closes the container', async () => {
    const events: string[] = [];
    const testApp = await track(
      createTestApp({
        modules: [...APP_MODULES, recordingModule('first', events), recordingModule('second', events)],
        routes: (scope) => {
          scope.get('/socket', { websocket: true }, () => {
            // Kept open: only the shutdown closes it.
          });
          scope.addHook('onClose', (instance, done) => {
            events.push(`app.closed shuttingDown=${String(instance.lifecycleState.shuttingDown)}`);
            done();
          });
        },
      }),
    );
    const { snap, container } = testApp;
    const closeContainer = container.close.bind(container);
    const containerClose = vi.spyOn(container, 'close').mockImplementation(() => {
      events.push('container.close');
      return closeContainer();
    });
    const baseUrl = await testApp.listen();
    const socket = await openWs(socketUrl(baseUrl, '/socket'));
    const closeCode = new Promise<number>((resolve) => {
      socket.once('close', (code: number) => {
        resolve(code);
      });
    });

    await gracefulShutdown(snap, container);

    expect(await closeCode).toBe(GOING_AWAY);
    expect(events).toEqual([
      'start:first',
      'start:second',
      'app.closed shuttingDown=true',
      'stop:second',
      'stop:first',
      'container.close',
    ]);
    expect(snap.app.server.listening).toBe(false);
    await redisEnded(container);
    expect(container.db.pool.ended).toBe(true);
    containerClose.mockRestore();
    await expect(container.close()).resolves.toBeUndefined();
  });
});

describe('process entry (main.ts)', () => {
  let blocker: Server | undefined;

  afterEach(async () => {
    await new Promise<void>((resolve) => {
      if (blocker === undefined) resolve();
      else
        blocker.close(() => {
          resolve();
        });
    });
    blocker = undefined;
  });

  it('exits 1 soon after a failed listen (EADDRINUSE) instead of hanging on open sockets', async () => {
    const server = createServer();
    blocker = server;
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;
    const instanceId = nextInstanceId();

    const child = spawn(
      process.execPath,
      ['--conditions=@snapland/source', '--import', 'tsx', 'src/main.ts'],
      {
        cwd: BACKEND_DIR,
        env: {
          ...process.env,
          HOST: '127.0.0.1',
          PORT: String(port),
          INSTANCE_ID: instanceId,
          SHUTDOWN_GRACE_MS: '5000',
          LOG_PRETTY: 'false',
          LOG_LEVEL: 'info',
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
    let stdout = '';
    let fatalAt: number | undefined;
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => {
      stdout += chunk;
      if (fatalAt === undefined && stdout.includes('"level":"fatal"')) fatalAt = performance.now();
    });
    child.stderr.resume();
    const killer = setTimeout(() => child.kill(), 45_000);
    const exit = await new Promise<{ code: number | null; exitedAt: number }>((resolve) => {
      child.once('exit', (code) => {
        resolve({ code, exitedAt: performance.now() });
      });
    });
    clearTimeout(killer);

    expect(exit.code).toBe(1);
    expect(fatalAt).toBeDefined();
    // The exit follows the fatal line at once: nothing waits for the open Redis clients or the pool.
    expect(exit.exitedAt - (fatalAt ?? 0)).toBeLessThan(5000);
    const fatal = stdout
      .split('\n')
      .filter((line) => line.startsWith('{'))
      .map((line) => JSON.parse(line) as Record<string, unknown>)
      .find((line) => line['level'] === 'fatal');
    expect(fatal).toMatchObject({ msg: 'startup failed', instanceId });
    expect(JSON.stringify(fatal)).toContain('EADDRINUSE');
  }, 60_000);
});
