/**
 * Unref'd timers of the realtime module: a forgotten timer can never keep a process or a test run alive. Unit tests
 * drive them with `vi.useFakeTimers()`; only the Clock (and the re-validation jitter's randomness) stay injected
 * (SPEC section 3.8).
 */

/** Cancels a scheduled callback; calling it again (or after the callback ran) is a no-op. */
export type Cancel = () => void;

/** Node silently turns a larger delay into 1 ms; callers that need longer waits re-arm (see the expiry timer). */
export const MAX_TIMER_DELAY_MS = 2_147_483_647;

/** Runs `callback` once after `delayMs` (clamped to Node's 32-bit timer limit). */
export function unrefTimeout(callback: () => void, delayMs: number): Cancel {
  const timer = setTimeout(callback, Math.min(MAX_TIMER_DELAY_MS, Math.max(0, delayMs)));
  timer.unref();
  return () => {
    clearTimeout(timer);
  };
}

/** Runs `callback` after the current I/O phase (used to batch outbound flushes). */
export function unrefImmediate(callback: () => void): Cancel {
  const immediate = setImmediate(callback);
  immediate.unref();
  return () => {
    clearImmediate(immediate);
  };
}

/**
 * Runs `task` again and again: the next run is scheduled `nextDelayMs()` after the previous one settled, so runs
 * never overlap. A failing run is reported to `onError` and does not stop the loop.
 */
export function repeat(
  nextDelayMs: () => number,
  task: () => Promise<void> | void,
  onError: (error: unknown) => void,
): Cancel {
  let cancel: Cancel | null = null;
  let stopped = false;
  const schedule = (): void => {
    cancel = unrefTimeout(() => {
      Promise.resolve()
        .then(task)
        .catch(onError)
        .finally(() => {
          if (!stopped) schedule();
        });
    }, nextDelayMs());
  };
  schedule();
  return () => {
    stopped = true;
    cancel?.();
  };
}
