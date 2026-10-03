/**
 * Timer of the retention job (SPEC section 5.6): first run after `RETENTION_INITIAL_DELAY_MS`, then every
 * `RETENTION_INTERVAL_MS` +/- 10 %. Timers are `.unref()`'d; `stop()` cancels the next run, asks a run in progress to
 * stop after its current batch, and waits for it (idempotent).
 */
import { runDetached } from '../../infra/lifecycle.js';
import type { Logger } from '../../infra/logger.js';
import type { RetentionRunResult } from './retention.service.js';

export interface RetentionRunner {
  runOnce(): Promise<RetentionRunResult>;
  requestStop(): void;
}

export interface RetentionJobOptions {
  runner: RetentionRunner;
  initialDelayMs: number;
  intervalMs: number;
  logger: Logger;
  /** Uniform in [0, 1); injected so tests use fixed values. */
  random?: () => number;
}

export class RetentionJob {
  readonly #options: RetentionJobOptions;
  #timer: NodeJS.Timeout | undefined;
  #running: Promise<void> | undefined;
  #stopped = false;

  constructor(options: RetentionJobOptions) {
    this.#options = options;
  }

  /** Called once, after listen(). */
  start(): void {
    this.#schedule(this.#options.initialDelayMs);
  }

  async stop(): Promise<void> {
    this.#stopped = true;
    if (this.#timer !== undefined) clearTimeout(this.#timer);
    this.#timer = undefined;
    this.#options.runner.requestStop();
    await this.#running;
  }

  #schedule(delayMs: number): void {
    if (this.#stopped) return;
    this.#timer = setTimeout(() => {
      this.#timer = undefined;
      this.#running = this.#runAndReschedule().finally(() => {
        this.#running = undefined;
      });
      runDetached(this.#running, this.#options.logger, 'retention run');
    }, delayMs);
    this.#timer.unref();
  }

  async #runAndReschedule(): Promise<void> {
    const { runner, intervalMs, random = Math.random } = this.#options;
    await runner.runOnce();
    // +/- 10 % jitter: instances started together drift apart instead of contending for the lock at the same instant.
    this.#schedule(Math.round(intervalMs * (0.9 + 0.2 * random())));
  }
}
