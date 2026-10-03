/**
 * Graceful shutdown (SPEC section 10.12): readiness 503 -> WebSockets closed with 1001 (preClose) -> HTTP drained
 * (`app.close()`) -> module background work stopped in reverse order -> `container.close()` (audit flush, limiter/cache
 * timers, bus, Redis, pool). `installShutdownHandlers` wires SIGTERM/SIGINT and fatal process errors through
 * close-with-grace; it is called ONLY from `main.ts` (no process-global handlers anywhere else).
 */
import closeWithGrace from 'close-with-grace';

import type { SnaplandApp } from '../app.js';
import type { Container } from '../container.js';
import type { Logger } from './logger.js';

export async function gracefulShutdown(snap: SnaplandApp, container: Container): Promise<void> {
  snap.app.lifecycleState.shuttingDown = true;
  await snap.app.close();
  await snap.stop();
  await container.close();
}

export interface ShutdownHandlerOptions {
  snap: SnaplandApp;
  container: Container;
  logger: Logger;
  graceMs: number;
}

/** Installs the process handlers; exit code 0 after a clean signal-triggered shutdown, 1 after a fatal error/timeout. */
export function installShutdownHandlers({ snap, container, logger, graceMs }: ShutdownHandlerOptions): void {
  closeWithGrace(
    {
      delay: graceMs,
      logger: {
        error: (message: unknown) => {
          logger.fatal({ detail: message }, 'shutdown error');
        },
      },
      onTimeout: (delay) => {
        logger.fatal({ graceMs: delay }, 'graceful shutdown timed out; exiting');
      },
    },
    async ({ signal, err }) => {
      if (err !== undefined) logger.fatal({ err }, 'fatal error; shutting down');
      else logger.info({ signal }, 'shutdown requested');
      await gracefulShutdown(snap, container);
      logger.info('shutdown complete');
    },
  );
}
