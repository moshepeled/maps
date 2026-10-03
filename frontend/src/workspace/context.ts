/**
 * The dependencies every workspace flow shares (the controllers of UX section 4 F-03 ... F-14). Flows receive this bag instead
 * of importing singletons, so each can be unit-tested with fakes; `createWorkspace()` builds the real one.
 */
import type { Bbox, Position, UserDto } from '@snapland/shared';

import type { AreasApi } from '../api/areas';
import type { AuthApi } from '../api/endpoints';
import { isApiError } from '../api/http';
import type { AppStores } from '../app/stores';
import type { Scheduler } from '../lib/scheduler';
import type { DraftSession } from '../realtime/draftSession';
import type { RealtimeClient } from '../realtime/RealtimeClient';
import type { ClockState } from '../state/clockStore';
import type { Toast } from '../state/toastsStore';
import { OWN_MAX, OWN_MAX_PHONE } from '../state/toastsStore';
import type { StoreApi } from 'zustand/vanilla';

/** What the flows need from the Leaflet map (implemented by `map/MapController.ts`). */
export interface MapBridge {
  focusMap(): void;
  /** The map centre (= the keyboard reticle), 7 dp not applied. */
  center(): Position | null;
  fitPositions(positions: readonly Position[]): void;
  flyToBbox(bbox: Bbox): void;
  zoomBy(delta: number): void;
  /** Container pixel of a WGS84 position in the current map (CRS-aware). */
  project(position: Position): { x: number; y: number } | null;
  /** The position `dx`, `dy` screen pixels away from `position` (keyboard point moves, UX C-12). */
  offset(position: Position, dx: number, dy: number): Position | null;
  /** Pans so that `position` is visible away from the chrome (UX-AC-99). */
  ensureVisible(position: Position): void;
  /** Pans `bbox` out from under the overlay inspector / sheet; zooms out only if it cannot fit (UX section 3.2). */
  revealBbox(bbox: Bbox): void;
  /** *Retry* on the tiles-failing notice (UX section 7). */
  retryTiles(): void;
}

export type RealtimeTransport = Pick<RealtimeClient, 'send' | 'request' | 'isLive' | 'connectionState'>;

export interface WorkspaceContext {
  stores: AppStores;
  clock: StoreApi<ClockState>;
  api: { areas: AreasApi; auth: AuthApi };
  realtime: RealtimeTransport;
  draft: DraftSession;
  scheduler: Scheduler;
  newId(): string;
  map(): MapBridge | null;
  /** True while `prefers-reduced-motion: reduce` matches (pulse -> static ring, UX C-08). */
  reducedMotion(): boolean;
  /** True below 600 px: `.short` copy variants (UX section 9). */
  isPhone(): boolean;
}

export function currentUser(ctx: WorkspaceContext): UserDto | null {
  return ctx.stores.auth.getState().user;
}

export function now(ctx: WorkspaceContext): number {
  return ctx.scheduler.now();
}

export type ToastInput = Omit<Toast, 'id' | 'createdAt'>;

/** Pushes a toast and announces it in the matching live region (UX C-18 "Announcements"). */
export function showToast(ctx: WorkspaceContext, toast: ToastInput): string {
  const ownMax = ctx.isPhone() ? OWN_MAX_PHONE : OWN_MAX;
  const id = ctx.stores.toasts.getState().push(toast, ctx.scheduler.now(), ownMax);
  const region = toast.kind === 'error' ? 'alert' : toast.lane === 'collab' ? null : 'status';
  if (region !== null) ctx.stores.live.getState().announce(region, toast.text);
  return id;
}

export function announce(ctx: WorkspaceContext, region: 'status' | 'alert', text: string): void {
  ctx.stores.live.getState().announce(region, text);
}

/**
 * Did this write fail because the session ended (UX F-11 step 4)? Only then is its retry held until the session dialog
 * signs the user in again. Any other 401 (e.g. `TOKEN_INVALID` with no dialog open) is an ordinary failure with a
 * Retry toast - holding it would make the write fail silently, since nothing would ever run the held retry.
 */
export function awaitsSignIn(ctx: WorkspaceContext, error: unknown): boolean {
  if (isApiError(error, 'SESSION_ENDED')) return true;
  return isApiError(error) && error.status === 401 && ctx.stores.auth.getState().sessionProblem !== null;
}
