/**
 * Reconnect delays (SPEC section 7.12 step 1, section 7.11): full jitter over `min(30 s, 0.5 s, 2^attempt)` spreads the reconnect
 * storm when an instance dies; some close codes impose a floor (1013 slow consumer >= 2 s; 4400 / 4429 >= 10 s).
 */
import { CLOSE_CODES, REALTIME } from '@snapland/shared';

/** Full-jitter delay for `attempt` (>= 1) with an injected `random()` in [0, 1). */
export function backoffDelayMs(attempt: number, random: () => number): number {
  const ceiling = Math.min(REALTIME.reconnectCapMs, REALTIME.reconnectBaseMs * 2 ** attempt);
  return Math.floor(random() * ceiling);
}

/** The minimum delay a close code imposes before the next attempt (0 when none). */
export function closeCodeFloorMs(code: number): number {
  if (code === CLOSE_CODES.TRY_AGAIN_LATER) return 2000;
  if (code === CLOSE_CODES.INVALID_MESSAGES || code === CLOSE_CODES.FLOOD) return 10_000;
  return 0;
}

/** Close codes that are protocol bugs worth reporting through `POST /client-errors` (SPEC section 3.6, section 7.11). */
export function isReportableClose(code: number): boolean {
  return (
    code === CLOSE_CODES.UNSUPPORTED_DATA ||
    code === CLOSE_CODES.MESSAGE_TOO_BIG ||
    code === CLOSE_CODES.INVALID_MESSAGES
  );
}

/** A deterministic PRNG (mulberry32) for tests and reproducible runs. */
export function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}
