/**
 * Who is on the map (SPEC section 7.7, UX section 6.1): presence entries per connection, grouped per user for display (several tabs
 * are one person; the busiest status wins). In limited mode the list comes from `GET /presence` without status.
 */
import type { PresenceDto, PresenceStatus, UserRef } from '@snapland/shared';
import { createStore } from 'zustand/vanilla';

export type PresenceSource = 'ws' | 'rest' | 'none';

export interface PresenceState {
  entries: ReadonlyMap<string, PresenceDto>;
  onlineCount: number;
  truncated: boolean;
  source: PresenceSource;
  /** The busy-area counter shown while collaboration toasts are paused (UX section 6.5). */
  changesCounter: number;
}

export interface PresenceStore extends PresenceState {
  snapshot(
    items: readonly PresenceDto[],
    onlineCount: number,
    truncated: boolean,
    source: PresenceSource,
  ): void;
  upsert(presence: PresenceDto): void;
  remove(connectionId: string): void;
  clear(): void;
  setChangesCounter(count: number): void;
}

export function createPresenceStore() {
  return createStore<PresenceStore>()((set, get) => ({
    entries: new Map(),
    onlineCount: 0,
    truncated: false,
    source: 'none',
    changesCounter: 0,
    snapshot: (items, onlineCount, truncated, source) => {
      set({
        entries: new Map(items.map((item) => [item.connectionId, item])),
        onlineCount,
        truncated,
        source,
      });
    },
    upsert: (presence) => {
      const entries = new Map(get().entries);
      entries.set(presence.connectionId, presence);
      set({ entries });
    },
    remove: (connectionId) => {
      if (!get().entries.has(connectionId)) return;
      const entries = new Map(get().entries);
      entries.delete(connectionId);
      set({ entries });
    },
    clear: () => {
      set({ entries: new Map(), onlineCount: 0, truncated: false, source: 'none' });
    },
    setChangesCounter: (count) => {
      set({ changesCounter: count });
    },
  }));
}

export type PresenceStoreApi = ReturnType<typeof createPresenceStore>;

export interface PresenceUser {
  userId: string;
  displayName: string;
  color: string;
  /** `unknown` in limited mode (polled rows carry no reliable status, UX section 6.1). */
  status: PresenceStatus | 'unknown';
  activeAreaId: string | null;
  connections: number;
  isMe: boolean;
}

const STATUS_RANK: Record<PresenceStatus, number> = { editing: 4, drawing: 3, viewing: 2, idle: 1 };

/**
 * One row per user (UX section 6.1): my row first, then drawing/editing, then viewing, then alphabetical. I am always
 * in the list: the polled list of Limited mode holds live connections only, and mine is the one that is down.
 */
export function groupPresence(
  entries: Iterable<PresenceDto>,
  me: UserRef | null,
  source: PresenceSource,
): PresenceUser[] {
  const byUser = new Map<string, PresenceUser>();
  if (me !== null) {
    byUser.set(me.id, {
      userId: me.id,
      displayName: me.displayName,
      color: me.color,
      status: 'unknown',
      activeAreaId: null,
      connections: 0,
      isMe: true,
    });
  }
  for (const entry of entries) {
    const existing = byUser.get(entry.userId);
    const status = source === 'rest' ? 'unknown' : entry.status;
    if (existing === undefined) {
      byUser.set(entry.userId, {
        userId: entry.userId,
        displayName: entry.displayName,
        color: entry.color,
        status,
        activeAreaId: entry.activeAreaId,
        connections: 1,
        isMe: false,
      });
      continue;
    }
    existing.connections += 1;
    if (
      status !== 'unknown' &&
      (existing.status === 'unknown' || STATUS_RANK[status] > STATUS_RANK[existing.status])
    ) {
      existing.status = status;
      existing.activeAreaId = entry.activeAreaId;
    }
  }
  const rank = (user: PresenceUser): number => (user.status === 'unknown' ? 0 : STATUS_RANK[user.status]);
  return [...byUser.values()].sort((left, right) => {
    if (left.isMe !== right.isMe) return left.isMe ? -1 : 1;
    const busy = Number(rank(right) >= 3) - Number(rank(left) >= 3);
    if (busy !== 0) return busy;
    return left.displayName.localeCompare(right.displayName);
  });
}
