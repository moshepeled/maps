/**
 * Process entry (SPEC section 3.1): load `.env` (local dev only) -> validate config (fail fast listing every problem) ->
 * container -> app -> listen -> start module background work -> install shutdown handlers. The only file that installs
 * process-wide handlers or calls `process.exit`.
 *
 * Any startup failure exits with code 1 (compose restarts the container). The exit is also what releases whatever a
 * half-started process holds open (listening socket, Redis clients, pool); nothing is torn down first.
 */
import { writeSync } from 'node:fs';

import { buildApp } from './app.js';
import { ConfigError, loadConfigFromEnv } from './config/env.js';
import { createContainer } from './container.js';
import { waitUntilReady } from './infra/redis/client.js';
import { installShutdownHandlers } from './infra/shutdown.js';

/** How long the process waits for Redis before serving (degraded afterwards, section 10.6). */
const REDIS_STARTUP_WAIT_MS = 5000;
const EXIT_STARTUP_FAILED = 1;
const STDERR_FD = 2;

async function main(): Promise<void> {
  const config = loadConfigFromEnv();
  const container = createContainer(config);
  const { logger } = container;
  try {
    if (!(await waitUntilReady(container.redis, REDIS_STARTUP_WAIT_MS))) {
      logger.warn(
        'Redis is not reachable yet; starting degraded (limiter fallback, cache bypass, no realtime fan-out)',
      );
    }
    const snap = await buildApp(container);
    installShutdownHandlers({ snap, container, logger, graceMs: config.SHUTDOWN_GRACE_MS });
    await snap.app.listen({ host: config.HOST, port: config.PORT });
    await snap.start();
    logger.info(
      { host: config.HOST, port: config.PORT, instanceId: container.instanceId },
      'Snapland backend started',
    );
  } catch (error) {
    // pino flushes its stdout destination on exit, so the line is never lost.
    logger.fatal({ err: error }, 'startup failed');
    process.exit(EXIT_STARTUP_FAILED);
  }
}

/** Failures before the logger exists (invalid configuration, container construction): one JSON line on stderr. */
function reportEarlyFailure(error: unknown): void {
  const message =
    error instanceof ConfigError
      ? error.message
      : error instanceof Error
        ? (error.stack ?? error.message)
        : String(error);
  // writeSync: the line must be on stderr before process.exit, whatever stderr is connected to.
  writeSync(
    STDERR_FD,
    `${JSON.stringify({ level: 'fatal', time: new Date().toISOString(), msg: 'startup failed', error: message })}\n`,
  );
}

main().catch((error: unknown) => {
  reportEarlyFailure(error);
  process.exit(EXIT_STARTUP_FAILED);
});
