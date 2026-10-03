/** Injected time source (SPEC section 3.8): behaviour that depends on time takes a Clock so tests can control it. */
export interface Clock {
  /** Epoch milliseconds. */
  now(): number;
}

export const systemClock: Clock = { now: () => Date.now() };
