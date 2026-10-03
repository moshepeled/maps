/**
 * Lifecycle contracts of infra components with background work (SPEC section 3.3, section 10.12): every timer is `.unref()`'d
 * and every `close()` is idempotent, so a test that forgets to close cannot hang Vitest.
 */
import type { Logger } from './logger.js';

export interface Lifecycle {
  start?(): void;
  close?(): Promise<void>;
}

/**
 * Starts background work without awaiting it; a rejection is logged instead of becoming an unhandled rejection
 * (section 3.8: no floating promises).
 */
export function runDetached(promise: Promise<unknown>, logger: Logger, label: string): void {
  promise.catch((error: unknown) => {
    logger.error({ err: error, task: label }, 'background task failed');
  });
}

/** Wraps an async close so that repeated calls share the first run (idempotent `close()`). */
export function idempotent(close: () => Promise<void>): () => Promise<void> {
  let running: Promise<void> | undefined;
  return () => {
    running ??= close();
    return running;
  };
}
