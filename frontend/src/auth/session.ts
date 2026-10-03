/**
 * Session lifecycle (SPEC section 6.2, UX F-01, F-11): silent refresh at boot, proactive refresh before expiry, and a
 * single-flight refresh on TOKEN_EXPIRED that is serialised across tabs with the Web Locks API - rotating refresh
 * tokens make parallel refreshes from two tabs look like token reuse otherwise.
 *
 * Failure mapping (UX F-11 step 2): REFRESH_TOKEN_INVALID -> "expired" dialog; SESSION_REVOKED / REFRESH_TOKEN_REUSED ->
 * "revoked" dialog; 429 -> wait `Retry-After` and retry (never a session failure); network / 5xx -> not a session
 * failure either (the connection pill reports it).
 */
import type { AuthResponse } from '@snapland/shared';

import { TOKEN_REFRESH_LEAD_MS } from '../constants/ux';
import type { ApiError, RefreshOutcome, TokenSource } from '../api/http';
import { isApiError } from '../api/http';
import type { Scheduler } from '../lib/scheduler';
import { Timer } from '../lib/scheduler';
import type { AuthStoreApi } from './authStore';

export interface LockManagerLike {
  request<T>(name: string, callback: () => Promise<T>): Promise<T>;
}

export interface SessionManagerDeps {
  store: AuthStoreApi;
  scheduler: Scheduler;
  /** `POST /auth/refresh` (cookie only). */
  callRefresh(): Promise<AuthResponse>;
  locks: LockManagerLike | null;
  /** Waits (injected so tests use fake timers). */
  sleep(ms: number): Promise<void>;
}

const REFRESH_LOCK = 'snapland-refresh';
const MAX_RATE_LIMITED_RETRIES = 3;
/** A parallel tab may have just rotated the cookie (SPEC section 6.2 rotation step 2: a 10 s grace answers 401 INVALID). */
const ROTATION_RACE_RETRY_MS = 300;

function failureOf(error: ApiError): 'expired' | 'revoked' | 'network' | 'rate-limited' {
  if (error.status === 401) {
    return error.code === 'SESSION_REVOKED' || error.code === 'REFRESH_TOKEN_REUSED' ? 'revoked' : 'expired';
  }
  if (error.status === 429) return 'rate-limited';
  return 'network';
}

export class SessionManager implements TokenSource {
  private inFlight: Promise<RefreshOutcome> | null = null;
  private readonly proactiveTimer: Timer;

  constructor(private readonly deps: SessionManagerDeps) {
    this.proactiveTimer = new Timer(deps.scheduler, () => {
      void this.refresh();
    });
  }

  accessToken(): string | null {
    return this.deps.store.getState().accessToken;
  }

  /** Boot (UX F-01 step 1): a silent refresh decides between the workspace and `/signin`. */
  async bootstrap(): Promise<boolean> {
    const outcome = await this.refresh();
    if (!outcome.ok && this.deps.store.getState().status === 'booting')
      this.deps.store.getState().markSignedOut();
    return outcome.ok;
  }

  /** Stores a fresh session (login, register, refresh) and arms the proactive refresh. */
  adopt(response: AuthResponse): void {
    this.deps.store.getState().setSession(response);
    const expiresAt = Date.parse(response.accessTokenExpiresAt);
    const delay = Math.max(0, expiresAt - this.deps.scheduler.now() - TOKEN_REFRESH_LEAD_MS);
    this.proactiveTimer.arm(delay);
  }

  signedOut(): void {
    this.proactiveTimer.cancel();
    this.deps.store.getState().markSignedOut();
  }

  refresh(): Promise<RefreshOutcome> {
    if (this.inFlight !== null) return this.inFlight;
    const run = (): Promise<RefreshOutcome> => this.refreshWithRetries();
    const locked = this.deps.locks === null ? run() : this.deps.locks.request(REFRESH_LOCK, run);
    this.inFlight = locked.finally(() => {
      this.inFlight = null;
    });
    return this.inFlight;
  }

  private async refreshWithRetries(): Promise<RefreshOutcome> {
    let rateLimited = 0;
    let raceRetried = false;
    for (;;) {
      try {
        this.adopt(await this.deps.callRefresh());
        return { ok: true };
      } catch (error) {
        if (!isApiError(error)) return { ok: false, reason: 'network', cause: null };
        const failure = failureOf(error);
        if (failure === 'rate-limited' && rateLimited < MAX_RATE_LIMITED_RETRIES) {
          rateLimited += 1;
          await this.deps.sleep(error.retryAfterMs ?? 1000);
          continue;
        }
        const hadSession = this.deps.store.getState().status === 'signed-in';
        if (failure === 'expired' && hadSession && !raceRetried && error.code === 'REFRESH_TOKEN_INVALID') {
          raceRetried = true;
          await this.deps.sleep(ROTATION_RACE_RETRY_MS);
          continue;
        }
        if (failure === 'expired' || failure === 'revoked') {
          this.onSessionEnded(failure);
          return { ok: false, reason: failure };
        }
        // 5xx, transport errors and an exhausted 429 budget: the caller fails with this error (UX F-11 step 2).
        return { ok: false, reason: 'network', cause: error };
      }
    }
  }

  private onSessionEnded(problem: 'expired' | 'revoked'): void {
    this.proactiveTimer.cancel();
    const state = this.deps.store.getState();
    // At boot there is no work to protect: go to the sign-in page. Later, the dialog keeps the workspace intact.
    if (state.status === 'signed-in') state.markSessionProblem(problem);
    else state.markSignedOut();
  }
}
