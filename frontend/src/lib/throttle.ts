/**
 * Rate shaping for outbound traffic and local persistence (SPEC section 7.8 client side): a leading + trailing throttle that
 * always delivers the final value, and a trailing debounce. Both take an injected scheduler.
 */
import type { Scheduler } from './scheduler';
import { Timer } from './scheduler';

export interface Throttled<T> {
  /** Offers a value: sent at once when the interval has passed, otherwise the latest value is sent when it does. */
  push(value: T): void;
  /** Sends a pending value now (e.g. before a save). */
  flush(): void;
  /** Drops a pending value. */
  cancel(): void;
}

/** At most one `send` per `intervalMs`; the last value offered is never lost (trailing edge). */
export function createThrottle<T>(
  send: (value: T) => void,
  intervalMs: number,
  scheduler: Scheduler,
): Throttled<T> {
  let lastSentAt = Number.NEGATIVE_INFINITY;
  let pending: { value: T } | null = null;

  const deliver = (): void => {
    if (pending === null) return;
    const { value } = pending;
    pending = null;
    lastSentAt = scheduler.now();
    send(value);
  };
  const timer = new Timer(scheduler, deliver);

  return {
    push(value: T): void {
      pending = { value };
      const wait = lastSentAt + intervalMs - scheduler.now();
      if (wait <= 0) {
        timer.cancel();
        deliver();
      } else if (!timer.pending) {
        timer.arm(wait);
      }
    },
    flush(): void {
      timer.cancel();
      deliver();
    },
    cancel(): void {
      timer.cancel();
      pending = null;
    },
  };
}

export interface Debounced<T> {
  push(value: T): void;
  flush(): void;
  cancel(): void;
}

/** Runs `run` with the latest value once `delayMs` passed without a new value. */
export function createDebounce<T>(
  run: (value: T) => void,
  delayMs: number,
  scheduler: Scheduler,
): Debounced<T> {
  let pending: { value: T } | null = null;
  const timer = new Timer(scheduler, () => {
    if (pending === null) return;
    const { value } = pending;
    pending = null;
    run(value);
  });
  return {
    push(value: T): void {
      pending = { value };
      timer.arm(delayMs);
    },
    flush(): void {
      timer.cancel();
      if (pending === null) return;
      const { value } = pending;
      pending = null;
      run(value);
    },
    cancel(): void {
      timer.cancel();
      pending = null;
    },
  };
}
