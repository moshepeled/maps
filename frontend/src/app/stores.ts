/**
 * Every client store, created once per app instance (tests create their own bundle). Geometry lives only in these
 * stores, as WGS84 lat/lng; the map, the HUD and the panels are views of them (SPEC section 8.4).
 */
import type { StoreApi } from 'zustand/vanilla';

import { createAuthStore } from '../auth/authStore';
import { createActivityStore } from '../state/activityStore';
import { createAreasStore } from '../state/areasStore';
import { createConnectionStore } from '../state/connectionStore';
import { createDrawingStore } from '../state/drawingStore';
import { createEditStore } from '../state/editStore';
import { createEffectsStore } from '../state/effectsStore';
import { createLiveRegionStore } from '../state/liveRegionStore';
import { createLocksStore } from '../state/locksStore';
import { createMapViewStore } from '../state/mapViewStore';
import { createNoticesStore } from '../state/noticesStore';
import { createPresenceStore } from '../state/presenceStore';
import { createRemoteDraftsStore } from '../state/remoteDraftsStore';
import { createRuntimeConfigStore } from '../state/runtimeConfigStore';
import { createToastsStore } from '../state/toastsStore';
import { createWorkspaceStore } from '../state/workspaceStore';

export function createAppStores() {
  return {
    activity: createActivityStore(),
    auth: createAuthStore(),
    areas: createAreasStore(),
    connection: createConnectionStore(),
    drawing: createDrawingStore(),
    edit: createEditStore(),
    effects: createEffectsStore(),
    live: createLiveRegionStore(),
    locks: createLocksStore(),
    mapView: createMapViewStore(),
    notices: createNoticesStore(),
    presence: createPresenceStore(),
    remoteDrafts: createRemoteDraftsStore(),
    runtime: createRuntimeConfigStore(),
    toasts: createToastsStore(),
    workspace: createWorkspaceStore(),
  };
}

export type AppStores = ReturnType<typeof createAppStores>;

/** Stores that outlive a user: the session (owned by `SessionManager`) and the server's runtime configuration. */
type SharedStoreKey = 'auth' | 'runtime';

/**
 * Returns every per-user store to its initial state. The stores live as long as the tab, but a workspace belongs to
 * one signed-in user: whoever signs in next must never see the previous user's mode, drawing, edit, toasts, notices,
 * locks, presence or remote drafts (UX F-11 "workspace reloads as new user"). Unsaved work survives only in that
 * user's own `localStorage` draft, which is offered back to them alone.
 */
export function resetUserStores(stores: AppStores): void {
  // One entry per store, checked by the type: a store added to `createAppStores()` must be classified here.
  const resets: Record<Exclude<keyof AppStores, SharedStoreKey>, () => void> = {
    // Session memory of others' changes (UX C-31): never shown to the next user.
    activity: () => {
      toInitialState(stores.activity);
    },
    // The area store bumps its revision on reset, so renderers that diff by revision redraw.
    areas: () => {
      stores.areas.getState().reset();
    },
    connection: () => {
      toInitialState(stores.connection);
    },
    drawing: () => {
      toInitialState(stores.drawing);
    },
    edit: () => {
      toInitialState(stores.edit);
    },
    effects: () => {
      toInitialState(stores.effects);
    },
    live: () => {
      toInitialState(stores.live);
    },
    locks: () => {
      toInitialState(stores.locks);
    },
    mapView: () => {
      toInitialState(stores.mapView);
    },
    notices: () => {
      toInitialState(stores.notices);
    },
    presence: () => {
      toInitialState(stores.presence);
    },
    remoteDrafts: () => {
      toInitialState(stores.remoteDrafts);
    },
    toasts: () => {
      toInitialState(stores.toasts);
    },
    workspace: () => {
      toInitialState(stores.workspace);
    },
  };
  for (const reset of Object.values(resets)) reset();
}

function toInitialState<T>(store: StoreApi<T>): void {
  store.setState(store.getInitialState(), true);
}
