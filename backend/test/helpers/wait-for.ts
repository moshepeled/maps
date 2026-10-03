/** `waitFor(predicate, timeoutMs)` (SPEC section 12.2): polling instead of fixed sleeps. */

export interface WaitForOptions {
  timeoutMs?: number;
  intervalMs?: number;
  /** Included in the timeout error. */
  description?: string;
}

type Pending = null | undefined | false;

/** Resolves with the first value of `probe` that is not null, undefined or false; rejects after the timeout. */
export async function waitFor<T>(
  probe: () => T | Pending | Promise<T | Pending>,
  options: WaitForOptions = {},
): Promise<T> {
  const timeoutMs = options.timeoutMs ?? 5000;
  const intervalMs = options.intervalMs ?? 25;
  // Monotonic clock: a wall-clock jump on the host must not end or stretch the wait.
  const deadline = performance.now() + timeoutMs;
  let lastError: unknown;
  for (;;) {
    try {
      const value = await probe();
      if (value !== null && value !== undefined && value !== false) return value;
    } catch (error) {
      lastError = error;
    }
    if (performance.now() >= deadline) {
      const reason = lastError instanceof Error ? `: ${lastError.message}` : '';
      throw new Error(
        `waitFor timed out after ${timeoutMs} ms (${options.description ?? 'condition'})${reason}`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

/** Measures how long an async operation takes, in ms. */
export async function timed<T>(operation: () => Promise<T>): Promise<{ result: T; elapsedMs: number }> {
  const started = performance.now();
  const result = await operation();
  return { result, elapsedMs: performance.now() - started };
}
