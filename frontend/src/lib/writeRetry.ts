/**
 * The retry policy of committed writes (UX F-03 step 9, F-12 step 3; SPEC section 10.6): every save, edit, rename, delete
 * and restore goes through `runWrite()`, which
 * - on 429 RATE_LIMITED shows a countdown (body `retryAfterMs` -> `Retry-After` -> 60 s) and sends automatically at 0,
 *   unless the user cancels first (then nothing is sent);
 * - on 503 (storage unavailable, request timeout, shutting down) retries up to 3 times after `Retry-After` (5 s
 *   default) while the caller shows the "Retrying..." toast, then reports a server failure;
 * - classifies every other failure for the caller's copy: network, timeout, server (5xx) or a typed HTTP problem.
 */
import type { ApiError } from '../api/http';
import { isApiError } from '../api/http';
import {
  RATE_LIMIT_DEFAULT_WAIT_MS,
  WRITE_503_DEFAULT_RETRY_MS,
  WRITE_503_MAX_RETRIES,
} from '../constants/ux';
import type { Scheduler, TimerHandle } from './scheduler';

export type WriteFailureReason = 'network' | 'timeout' | 'server' | 'problem';

export type WriteOutcome<T> =
  | { ok: true; value: T }
  | { ok: false; cancelled: true }
  | { ok: false; cancelled: false; reason: WriteFailureReason; error: unknown };

export interface WriteHooks {
  /** A 429 countdown started (`until` = epoch ms of the automatic send) or ended (null). */
  onCountdown?(until: number | null): void;
  /** 503 automatic retries are running (true) or over (false). */
  onStorageRetry?(active: boolean): void;
}

export interface WriteOptions extends WriteHooks {
  scheduler: Scheduler;
  maxStorageRetries?: number;
}

export interface WriteHandle<T> {
  readonly result: Promise<WriteOutcome<T>>;
  /** Cancels a pending countdown or retry wait: nothing more is sent. An in-flight request is not aborted. */
  cancel(): void;
}

const STORAGE_CODES: ReadonlySet<string> = new Set([
  'DEPENDENCY_UNAVAILABLE',
  'REQUEST_TIMEOUT',
  'SERVICE_UNAVAILABLE',
]);

/** 503s that a retry can fix: a storage code, or an edge 503 without a problem body; any other code is final. */
export function isStorageUnavailable(error: unknown): boolean {
  return (
    isApiError(error) && error.status === 503 && (STORAGE_CODES.has(error.code) || error.problem === null)
  );
}

export function isRateLimited(error: unknown): error is ApiError {
  return isApiError(error) && error.status === 429;
}

/** The wait before an automatic retry: `retryAfterMs` (body or header, already merged by the client) or `fallback`. */
export function retryDelayMs(error: unknown, fallback: number): number {
  return isApiError(error) && error.retryAfterMs !== null ? Math.max(0, error.retryAfterMs) : fallback;
}

export function classifyFailure(error: unknown): WriteFailureReason {
  if (!isApiError(error)) return 'network';
  if (error.kind === 'timeout') return 'timeout';
  if (error.kind === 'network') return 'network';
  if (error.status >= 500) return 'server';
  return 'problem';
}

export function runWrite<T>(operation: () => Promise<T>, options: WriteOptions): WriteHandle<T> {
  const { scheduler } = options;
  const maxRetries = options.maxStorageRetries ?? WRITE_503_MAX_RETRIES;
  let cancelled = false;
  let waiting: { handle: TimerHandle; resolve: () => void } | null = null;

  const wait = (ms: number): Promise<boolean> =>
    new Promise<boolean>((resolve) => {
      const handle = scheduler.setTimeout(() => {
        waiting = null;
        resolve(!cancelled);
      }, ms);
      waiting = {
        handle,
        resolve: () => {
          resolve(false);
        },
      };
    });

  const execute = async (): Promise<WriteOutcome<T>> => {
    let storageRetries = 0;
    for (;;) {
      if (cancelled) return { ok: false, cancelled: true };
      try {
        const value = await operation();
        if (storageRetries > 0) options.onStorageRetry?.(false);
        return { ok: true, value };
      } catch (error) {
        if (isRateLimited(error)) {
          const until = scheduler.now() + retryDelayMs(error, RATE_LIMIT_DEFAULT_WAIT_MS);
          options.onCountdown?.(until);
          const proceed = await wait(until - scheduler.now());
          options.onCountdown?.(null);
          if (!proceed) return { ok: false, cancelled: true };
          continue;
        }
        if (isStorageUnavailable(error) && storageRetries < maxRetries) {
          storageRetries += 1;
          options.onStorageRetry?.(true);
          const proceed = await wait(retryDelayMs(error, WRITE_503_DEFAULT_RETRY_MS));
          if (!proceed) {
            options.onStorageRetry?.(false);
            return { ok: false, cancelled: true };
          }
          continue;
        }
        if (storageRetries > 0) options.onStorageRetry?.(false);
        return { ok: false, cancelled: false, reason: classifyFailure(error), error };
      }
    }
  };

  return {
    result: execute(),
    cancel(): void {
      cancelled = true;
      const pending = waiting;
      if (pending === null) return;
      waiting = null;
      scheduler.clearTimeout(pending.handle);
      pending.resolve();
    },
  };
}
