/**
 * The single map-notice slot (UX C-17): all candidate notices are kept here and `topNotice()` picks exactly one by
 * the UX total order - restore draft > load error / read rate limit > storage > imagery > truncated > culled >
 * coverage > empty view.
 */
import { createStore } from 'zustand/vanilla';

import type { MapLoadState } from '../map/viewportSync';

export interface NoticesState {
  load: MapLoadState;
  /** The zoom at which the culling notice was dismissed (it returns when the zoom changes). */
  cullingDismissedAtZoom: number | null;
  emptyDismissed: boolean;
  /** No loaded area intersects the view, in a mode that offers the hint (Browse / AreaSelected, `offersEmptyHint`). */
  emptyView: boolean;
  /** *Aerial* (the ITM cache) is shown and the view centre is outside its coverage (UX section 7). */
  outsideCoverage: boolean;
  tilesFailing: 'map' | 'aerial' | null;
  restoreDraft: boolean;
}

export interface NoticesStore extends NoticesState {
  patch(patch: Partial<NoticesState>): void;
}

export const IDLE_LOAD: MapLoadState = {
  showProgress: false,
  loading: false,
  failure: null,
  truncatedShown: null,
  culledCount: 0,
  zoom: null,
};

export function createNoticesStore() {
  return createStore<NoticesStore>()((set) => ({
    load: IDLE_LOAD,
    cullingDismissedAtZoom: null,
    emptyDismissed: false,
    emptyView: false,
    outsideCoverage: false,
    tilesFailing: null,
    restoreDraft: false,
    patch: (patch) => {
      set(patch);
    },
  }));
}

export type NoticesStoreApi = ReturnType<typeof createNoticesStore>;

/** `data-testid` of each notice (UX section 12). */
export type NoticeId =
  | 'restore-draft-banner'
  | 'load-error'
  | 'read-rate-limit-notice'
  | 'storage-notice'
  | 'tiles-failing-notice'
  | 'truncation-notice'
  | 'culling-notice'
  | 'coverage-notice'
  | 'empty-hint';

/** The one notice to show (UX C-17 total order), or null. */
export function topNotice(state: NoticesState): NoticeId | null {
  if (state.restoreDraft) return 'restore-draft-banner';
  const failure = state.load.failure;
  if (failure?.kind === 'error') return 'load-error';
  if (failure?.kind === 'rate-limited') return 'read-rate-limit-notice';
  if (failure?.kind === 'storage') return 'storage-notice';
  if (state.tilesFailing !== null) return 'tiles-failing-notice';
  if (state.load.truncatedShown !== null) return 'truncation-notice';
  if (state.load.culledCount > 0 && state.cullingDismissedAtZoom !== state.load.zoom) return 'culling-notice';
  if (state.outsideCoverage) return 'coverage-notice';
  if (state.emptyView && !state.emptyDismissed && !state.load.loading) return 'empty-hint';
  return null;
}
