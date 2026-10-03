/**
 * Rejects when `task` has not settled within `ms` (the task itself is not cancelled). The timer is unref'd so a
 * pending race never keeps the process alive, and it is cleared however the race ends.
 */
export function withTimeout<T>(task: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(new Error(`timed out after ${ms} ms`));
    }, ms);
    timer.unref();
  });
  return Promise.race([task, timeout]).finally(() => {
    clearTimeout(timer);
  });
}
