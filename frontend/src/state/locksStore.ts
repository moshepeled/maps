/**
 * Advisory edit locks of other users (SPEC section 7.9, UX F-10): one holder per area, from `lock.snapshot` and
 * `lock.changed`. A lock whose `expiresAt` has passed is hidden; in limited/offline mode the lock state is unknown.
 */
import { createStore } from 'zustand/vanilla';

export interface LockHolder {
  userId: string;
  displayName: string;
  color: string;
}

export interface AreaLock {
  areaId: string;
  holder: LockHolder;
  scope: 'geometry' | 'details';
  expiresAt: number;
}

export interface LocksState {
  locks: ReadonlyMap<string, AreaLock>;
  /** False while the live channel is down or the lock service is unavailable (`lock.unknown`, UX F-10 step 10). */
  known: boolean;
}

export interface LocksStore extends LocksState {
  snapshot(
    items: readonly {
      areaId: string;
      holder: LockHolder;
      scope: 'geometry' | 'details';
      expiresAt: string;
    }[],
  ): void;
  changed(change: {
    areaId: string;
    holder: LockHolder | null;
    scope: 'geometry' | 'details' | null;
    expiresAt: string | null;
  }): void;
  setKnown(known: boolean): void;
  clear(): void;
}

export function createLocksStore() {
  return createStore<LocksStore>()((set, get) => ({
    locks: new Map(),
    known: false,
    snapshot: (items) => {
      set({
        known: true,
        locks: new Map(
          items.map((item) => [
            item.areaId,
            {
              areaId: item.areaId,
              holder: item.holder,
              scope: item.scope,
              expiresAt: Date.parse(item.expiresAt),
            },
          ]),
        ),
      });
    },
    changed: (change) => {
      const locks = new Map(get().locks);
      if (change.holder === null || change.scope === null || change.expiresAt === null) {
        locks.delete(change.areaId);
      } else {
        locks.set(change.areaId, {
          areaId: change.areaId,
          holder: change.holder,
          scope: change.scope,
          expiresAt: Date.parse(change.expiresAt),
        });
      }
      set({ locks });
    },
    setKnown: (known) => {
      set({ known });
    },
    clear: () => {
      set({ locks: new Map(), known: false });
    },
  }));
}

export type LocksStoreApi = ReturnType<typeof createLocksStore>;

/** The visible lock on an area: another user's, not expired (I never see a badge for myself, UX F-10 step 9). */
export function activeLock(
  state: LocksState,
  areaId: string,
  meId: string | null,
  now: number,
): AreaLock | null {
  const lock = state.locks.get(areaId);
  if (lock === undefined || lock.expiresAt <= now || lock.holder.userId === meId) return null;
  return lock;
}
