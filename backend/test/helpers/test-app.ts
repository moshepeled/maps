/**
 * `createTestApp` (SPEC section 12.2): a fully wired container + app built from the run's environment merged with per-test
 * config (validated by the same schema as production), optional container overrides (in-memory audit/limiter/bus),
 * optional test-only routes under `/__test/*`, and a unique `instanceId` (`<runId>-<n>`) so Redis connection names
 * never collide with another run. Logs are captured instead of printed.
 */
import { randomBytes } from 'node:crypto';

import { buildApp } from '../../src/app.js';
import type { BuildAppOptions, SnaplandApp } from '../../src/app.js';
import { loadConfig } from '../../src/config/env.js';
import type { AppConfig, AppConfigInput } from '../../src/config/env.js';
import { createContainer } from '../../src/container.js';
import type { Container, ContainerOverrides } from '../../src/container.js';
import type { AppInstance } from '../../src/infra/http/types.js';
import { idempotent } from '../../src/infra/lifecycle.js';
import { waitUntilReady } from '../../src/infra/redis/client.js';
import { createLogger } from '../../src/infra/logger.js';
import type { ModuleFactory } from '../../src/modules/types.js';
import { createLogCapture } from './log-capture.js';
import type { LogCapture } from './log-capture.js';

export interface TestAppOptions {
  /** Per-test configuration on top of the run's environment (env names, typed or string values). */
  config?: AppConfigInput;
  /** Container overrides (e.g. `{ audit: new InMemoryAuditLogger(...) }`); a logger is always injected. */
  overrides?: Omit<ContainerOverrides, 'logger'>;
  /** Test-only routes, registered under `/__test` with every app decoration available. */
  routes?: BuildAppOptions['testRoutes'];
  /** Module factories (default: every application module). */
  modules?: readonly ModuleFactory[];
  /** Default `<runId>-<n>`. */
  instanceId?: string;
}

export interface TestApp {
  readonly app: AppInstance;
  readonly container: Container;
  readonly config: AppConfig;
  readonly snap: SnaplandApp;
  readonly logs: LogCapture;
  /** Listens on an ephemeral loopback port (once) and returns the base URL, e.g. `http://127.0.0.1:53211`. */
  listen(): Promise<string>;
  /** Idempotent: app.close() -> module stop() -> container.close(). */
  close(): Promise<void>;
}

let instanceCounter = 0;
/** Short on purpose: apps pointed at a paused proxy simply start degraded. */
const REDIS_READY_TIMEOUT_MS = 2000;

export function testRunId(): string {
  const runId = process.env['TEST_RUN_ID'];
  if (runId === undefined || runId === '')
    throw new Error('TEST_RUN_ID is not set: run through vitest.integration.config.ts');
  return runId;
}

/** Per-file salt: test files have separate module state, so the counter alone would repeat across files. */
const INSTANCE_SALT = randomBytes(2).toString('hex');

export function nextInstanceId(): string {
  instanceCounter += 1;
  return `${testRunId()}-${INSTANCE_SALT}${instanceCounter}`;
}

/** Builds the validated config of a test app (the run's env + overrides). */
export function testConfig(overrides: AppConfigInput = {}, instanceId: string = nextInstanceId()): AppConfig {
  return loadConfig({ ...process.env, INSTANCE_ID: instanceId, ...overrides });
}

export async function createTestApp(options: TestAppOptions = {}): Promise<TestApp> {
  const instanceId = options.instanceId ?? nextInstanceId();
  const config = testConfig(options.config, instanceId);
  const logs = createLogCapture();
  const container = createContainer(config, {
    ...options.overrides,
    logger: createLogger(config, { destination: logs.stream }),
  });
  let snap: SnaplandApp;
  try {
    // Deterministic starts: requests of a fresh app would otherwise race the Redis connection (fail-fast clients).
    await waitUntilReady(container.redis, REDIS_READY_TIMEOUT_MS);
    snap = await buildApp(container, {
      ...(options.routes === undefined ? {} : { testRoutes: options.routes }),
      ...(options.modules === undefined ? {} : { modules: options.modules }),
    });
    await snap.app.ready();
    await snap.start();
  } catch (error) {
    await container.close();
    throw error;
  }

  let baseUrl: string | undefined;
  return {
    app: snap.app,
    container,
    config,
    snap,
    logs,
    async listen() {
      baseUrl ??= await snap.app.listen({ host: '127.0.0.1', port: 0 });
      return baseUrl;
    },
    close: idempotent(async () => {
      await snap.app.close();
      await snap.stop();
      await container.close();
    }),
  };
}
