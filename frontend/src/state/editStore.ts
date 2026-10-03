/**
 * Shape editing session state (UX F-04, F-09 step 1, F-10): the pure edit geometry plus what the HUD needs - lock
 * situation, early warnings, the save status and a server-reported invalid location.
 */
import type { Position, UserRef } from '@snapland/shared';
import { createStore } from 'zustand/vanilla';

import type { EditState } from './editReducer';

/** How my edit relates to the advisory lock (UX F-10). */
export type EditLockState = 'mine' | 'both' | 'race' | 'unknown' | 'none';

export interface EditStoreState {
  edit: EditState | null;
  /** Pointer-armed "Move point" or a live drag (for the invalid styling while dragging). */
  dragging: { index: number; position: Position; invalid: boolean } | null;
  lock: EditLockState;
  /** The other holder when `lock` is `both` / `race`. */
  lockHolder: { displayName: string; color: string } | null;
  /** A newer version arrived while editing (UX F-09 step 1). */
  newerVersion: { user: UserRef | null; version: number } | null;
  /** Another user is reshaping the same area without the lock (UX F-10 step 5). */
  otherEditor: { displayName: string } | null;
  saving: boolean;
  countdownUntil: number | null;
  serverInvalid: { code: string; location: Position | null } | null;
  /** The full-precision detail is being fetched before the edit can start (UX F-04 step 1). */
  loadingDetail: boolean;
}

export interface EditStore extends EditStoreState {
  patch(patch: Partial<EditStoreState>): void;
  setEdit(edit: EditState | null): void;
  reset(): void;
}

const INITIAL: EditStoreState = {
  edit: null,
  dragging: null,
  lock: 'none',
  lockHolder: null,
  newerVersion: null,
  otherEditor: null,
  saving: false,
  countdownUntil: null,
  serverInvalid: null,
  loadingDetail: false,
};

export function createEditStore() {
  return createStore<EditStore>()((set) => ({
    ...INITIAL,
    patch: (patch) => {
      set(patch);
    },
    setEdit: (edit) => {
      set({ edit });
    },
    reset: () => {
      set(INITIAL);
    },
  }));
}

export type EditStoreApi = ReturnType<typeof createEditStore>;
