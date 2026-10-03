/**
 * The composition root of the SPA (SPEC section 8.6): the stores, the HTTP client with its single-flight session refresh,
 * the API modules and the runtime configuration. Everything the workspace needs per signed-in user is created later
 * by `workspace/Workspace.ts`. Browser globals are injected so tests can build the services with fakes.
 */
import type { AuthResponse, ConfigResponse } from '@snapland/shared';
import { AuthResponseSchema } from '@snapland/shared';

import type { AreasApi } from '../api/areas';
import { createAreasApi } from '../api/areas';
import type { AuthApi, PresenceApi } from '../api/endpoints';
import { createAuthApi, createPresenceApi, fetchRuntimeConfig } from '../api/endpoints';
import type { HttpClient, RefreshOutcome } from '../api/http';
import { createHttpClient } from '../api/http';
import type { LockManagerLike } from '../auth/session';
import { SessionManager } from '../auth/session';
import { config } from '../config';
import type { Scheduler } from '../lib/scheduler';
import { systemScheduler } from '../lib/scheduler';
import type { ClockStoreApi } from '../state/clockStore';
import { createClockStore } from '../state/clockStore';
import type { AppStores } from './stores';
import { createAppStores } from './stores';

export interface AppServicesDeps {
  fetch: typeof fetch;
  scheduler: Scheduler;
  locks: LockManagerLike | null;
  apiBase: string;
}

export interface AppServices {
  stores: AppStores;
  clock: ClockStoreApi;
  http: HttpClient;
  session: SessionManager;
  api: { auth: AuthApi; areas: AreasApi; presence: PresenceApi };
  scheduler: Scheduler;
  /** Boot (UX F-01 step 1): runtime config and a silent refresh decide between the workspace and `/signin`. */
  bootstrap(): Promise<void>;
  /** Stores a new session after sign-in / sign-up / the session dialog. */
  adopt(response: AuthResponse): void;
  /** `POST /auth/logout` (best effort), then forget the session (UX F-14). */
  signOut(): Promise<void>;
}

function sleepWith(scheduler: Scheduler): (ms: number) => Promise<void> {
  return (ms) =>
    new Promise((resolve) => {
      scheduler.setTimeout(resolve, ms);
    });
}

/** The Web Locks API when the browser has it (refreshes are serialised across tabs, SPEC section 6.2). */
export function browserLocks(): LockManagerLike | null {
  const locks = (globalThis.navigator as Navigator | undefined)?.locks;
  if (locks === undefined) return null;
  return { request: (name, callback) => locks.request(name, callback) };
}

export function defaultServicesDeps(): AppServicesDeps {
  return {
    fetch: (input, init) => globalThis.fetch(input, init),
    scheduler: systemScheduler,
    locks: browserLocks(),
    apiBase: config.apiBase,
  };
}

export function createAppServices(deps: AppServicesDeps = defaultServicesDeps()): AppServices {
  const stores = createAppStores();
  const clock = createClockStore(deps.scheduler);
  let session: SessionManager | null = null;
  const tokens = {
    accessToken: (): string | null => stores.auth.getState().accessToken,
    refresh: (): Promise<RefreshOutcome> =>
      session === null ? Promise.resolve({ ok: false, reason: 'network', cause: null }) : session.refresh(),
  };
  const http = createHttpClient({ baseUrl: deps.apiBase, fetch: deps.fetch, tokens });
  const authApi = createAuthApi(http);
  const created = new SessionManager({
    store: stores.auth,
    scheduler: deps.scheduler,
    callRefresh: async () =>
      (await http.request('/auth/refresh', { method: 'POST', schema: AuthResponseSchema, auth: false })).data,
    locks: deps.locks,
    sleep: sleepWith(deps.scheduler),
  });
  session = created;

  const loadConfig = async (): Promise<void> => {
    try {
      const runtime: ConfigResponse = await fetchRuntimeConfig(http);
      stores.runtime.getState().setConfig(runtime);
    } catch {
      // The shared constants are the fallback until /config answers (UX section 11 "config" rows).
    }
  };

  return {
    stores,
    clock,
    http,
    session: created,
    api: { auth: authApi, areas: createAreasApi(http), presence: createPresenceApi(http) },
    scheduler: deps.scheduler,
    async bootstrap() {
      clock.start();
      await Promise.all([loadConfig(), created.bootstrap()]);
    },
    adopt(response) {
      created.adopt(response);
    },
    async signOut() {
      try {
        await authApi.logout();
      } catch {
        // Signing out locally must never fail; the server session expires on its own.
      }
      created.signedOut();
    },
  };
}
