/**
 * Injectable time source and timers (SPEC section 3.8: time is injected wherever behaviour depends on it). The system
 * implementation resolves the globals at call time, so Vitest fake timers drive it without any extra wiring.
 */

export type TimerHandle = ReturnType<typeof globalThis.setTimeout>;

export interface Scheduler {
  /** Epoch milliseconds. */
  now(): number;
  setTimeout(callback: () => void, delayMs: number): TimerHandle;
  clearTimeout(handle: TimerHandle | null | undefined): void;
}

export const systemScheduler: Scheduler = {
  now: () => Date.now(),
  setTimeout: (callback, delayMs) => globalThis.setTimeout(callback, delayMs),
  clearTimeout: (handle) => {
    if (handle !== null && handle !== undefined) globalThis.clearTimeout(handle);
  },
};

/** A single re-armable timer: `arm()` replaces any pending run, `cancel()` clears it. */
export class Timer {
  private handle: TimerHandle | null = null;

  constructor(
    private readonly scheduler: Scheduler,
    private readonly callback: () => void,
  ) {}

  arm(delayMs: number): void {
    this.cancel();
    this.handle = this.scheduler.setTimeout(() => {
      this.handle = null;
      this.callback();
    }, delayMs);
  }

  cancel(): void {
    this.scheduler.clearTimeout(this.handle);
    this.handle = null;
  }

  get pending(): boolean {
    return this.handle !== null;
  }
}
