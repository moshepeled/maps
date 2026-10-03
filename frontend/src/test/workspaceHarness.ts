/**
 * A `WorkspaceContext` wired to fakes (test-only): real stores and a real `DraftSession`, a scriptable realtime
 * transport, `vi.fn()` API doubles and a recording map bridge. Time is the system scheduler, so tests drive it with
 * `vi.useFakeTimers()`.
 */
import type { AreaDto, AreaMutationResponse, AuthResponse, ClientMessage, UserDto } from '@snapland/shared';
import { vi } from 'vitest';

import type { AreasApi } from '../api/areas';
import { ApiError } from '../api/http';
import type { AuthApi } from '../api/endpoints';
import { createAppStores } from '../app/stores';
import { systemScheduler } from '../lib/scheduler';
import { DraftSession } from '../realtime/draftSession';
import type { RequestResult } from '../realtime/RealtimeClient';
import { createClockStore } from '../state/clockStore';
import type { MapBridge, WorkspaceContext } from '../workspace/context';
import { ALICE, uuid } from './factories';

type Outbound = Omit<ClientMessage, 'ref'>;

export class FakeTransport {
  isLive = true;
  connectionState: 'live' | 'limited' = 'live';
  readonly sent: Outbound[] = [];
  readonly requests: Outbound[] = [];
  /** Answers requests; default: every request succeeds. */
  reply: (message: Outbound) => RequestResult = () => ({ ok: true, data: {} });

  send(message: Outbound): boolean {
    this.sent.push(message);
    return this.isLive;
  }

  request(message: Outbound): Promise<RequestResult> {
    this.requests.push(message);
    return Promise.resolve(this.reply(message));
  }

  ofType(type: string): Outbound[] {
    return [...this.sent, ...this.requests].filter((message) => message.type === type);
  }
}

export const ME: UserDto = {
  id: ALICE.id,
  username: 'alice',
  displayName: ALICE.displayName,
  color: ALICE.color,
  role: 'user',
  createdAt: '2026-09-27T10:00:00.000Z',
};

export function signedIn(user: UserDto = ME): AuthResponse {
  return {
    user,
    sessionId: '9b2d7c4e-5a61-4f3b-8e2a-1c0d9f8e7a61',
    accessToken: 'token',
    accessTokenExpiresAt: new Date(Date.now() + 15 * 60_000).toISOString(),
  };
}

export function mutation(area: AreaDto, extra: Partial<AreaMutationResponse> = {}): AreaMutationResponse {
  return { area, merged: false, noop: false, serverChangedFields: [], ...extra };
}

export function apiProblem(
  status: number,
  code: string,
  extensions: Record<string, unknown> = {},
  retryAfterMs: number | null = null,
): ApiError {
  const problem = { type: `urn:snapland:problem:${code}`, title: code, status, code, ...extensions };
  return new ApiError('http', status, code, problem as never, retryAfterMs, code);
}

export function networkError(): ApiError {
  return new ApiError('network', 0, 'NETWORK_ERROR', null, null, 'Network error');
}

export interface FakeAreasApi {
  listBbox: ReturnType<typeof vi.fn<AreasApi['listBbox']>>;
  changes: ReturnType<typeof vi.fn<AreasApi['changes']>>;
  get: ReturnType<typeof vi.fn<AreasApi['get']>>;
  create: ReturnType<typeof vi.fn<AreasApi['create']>>;
  update: ReturnType<typeof vi.fn<AreasApi['update']>>;
  remove: ReturnType<typeof vi.fn<AreasApi['remove']>>;
  restore: ReturnType<typeof vi.fn<AreasApi['restore']>>;
  versions: ReturnType<typeof vi.fn<AreasApi['versions']>>;
  version: ReturnType<typeof vi.fn<AreasApi['version']>>;
}

export interface MapCalls {
  focus: number;
  fits: unknown[];
  flights: unknown[];
}

export interface Harness {
  ctx: WorkspaceContext;
  transport: FakeTransport;
  api: FakeAreasApi;
  map: MapCalls;
  draft: DraftSession;
}

export function createHarness(
  options: { user?: UserDto; reducedMotion?: boolean; phone?: boolean } = {},
): Harness {
  const stores = createAppStores();
  stores.auth.getState().setSession(signedIn(options.user ?? ME));
  const transport = new FakeTransport();
  const clock = createClockStore(systemScheduler);
  const api: FakeAreasApi = {
    listBbox: vi.fn<AreasApi['listBbox']>(),
    changes: vi.fn<AreasApi['changes']>(),
    get: vi.fn<AreasApi['get']>(),
    create: vi.fn<AreasApi['create']>(),
    update: vi.fn<AreasApi['update']>(),
    remove: vi.fn<AreasApi['remove']>(),
    restore: vi.fn<AreasApi['restore']>(),
    versions: vi.fn<AreasApi['versions']>(),
    version: vi.fn<AreasApi['version']>(),
  };
  const map: MapCalls = { focus: 0, fits: [], flights: [] };
  const bridge: MapBridge = {
    focusMap: () => {
      map.focus += 1;
    },
    center: () => [34.78, 32.08],
    fitPositions: (positions) => {
      map.fits.push(positions);
    },
    flyToBbox: (bbox) => {
      map.flights.push(bbox);
    },
    zoomBy: () => undefined,
    project: (position) => ({ x: position[0], y: position[1] }),
    offset: (position, dx, dy) => [position[0] + dx * 1e-5, position[1] - dy * 1e-5],
    ensureVisible: () => undefined,
    revealBbox: () => undefined,
    retryTiles: () => undefined,
  };
  let ids = 0;
  const newId = (): string => {
    ids += 1;
    return uuid(0xd000 + ids);
  };
  const draft = new DraftSession({
    transport,
    scheduler: systemScheduler,
    newId,
    touchIntervalMs: () => 20_000,
    updateIntervalMs: () => 100,
    onStatus: (status) => {
      stores.drawing.getState().patch({ sharing: status });
    },
  });
  const authApi: AuthApi = {
    login: vi.fn(),
    register: vi.fn(),
    logout: vi.fn(),
    wsTicket: vi.fn(),
  };
  const ctx: WorkspaceContext = {
    stores,
    clock: clock.store,
    api: { areas: api, auth: authApi },
    realtime: transport,
    draft,
    scheduler: systemScheduler,
    newId,
    map: () => bridge,
    reducedMotion: () => options.reducedMotion ?? false,
    isPhone: () => options.phone ?? false,
  };
  return { ctx, transport, api, map, draft };
}

/** Lets pending promise callbacks run (fake timers do not advance microtasks by themselves). */
export async function flush(): Promise<void> {
  for (let i = 0; i < 5; i += 1) await Promise.resolve();
}
