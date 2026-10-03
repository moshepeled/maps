/**
 * The Activity section's record (UX C-31): the in-scope collaboration events of this session, newest first, at most
 * `ACTIVITY_MAX_ITEMS`. It is client-only session memory (SPEC v1 has no activity endpoint): a reload or a sign-out
 * empties it. Recording is independent of toasts - holding, batching, the burst rule and Quiet mode do not apply.
 */
import { createStore } from 'zustand/vanilla';

import { ACTIVITY_MAX_ITEMS } from '../constants/ux';

/** `activity-item[data-code]`: the copy key of the single-event collaboration message (UX section 9.8). */
export type ActivityCode =
  | 'collab.created'
  | 'collab.reshaped'
  | 'collab.renamed'
  | 'collab.described'
  | 'collab.updated'
  | 'collab.deleted'
  | 'collab.undeleted'
  | 'collab.restoredVersion';

export interface ActivityItem {
  /** Unique within the session (rows are keyed by it). */
  id: string;
  areaId: string;
  code: ActivityCode;
  actor: { id: string; displayName: string; color: string };
  /** The text a single-event collaboration toast would show. */
  text: string;
  /** The area's size when the event arrived; null for a deletion. */
  areaKm2: number | null;
  /** Epoch ms when the event arrived. */
  at: number;
}

export interface ActivityState {
  items: readonly ActivityItem[];
  record(item: Omit<ActivityItem, 'id'>): void;
}

export function createActivityStore() {
  let sequence = 0;
  return createStore<ActivityState>()((set, get) => ({
    items: [],
    record: (item) => {
      sequence += 1;
      set({ items: [{ ...item, id: `activity-${sequence}` }, ...get().items].slice(0, ACTIVITY_MAX_ITEMS) });
    },
  }));
}

export type ActivityStoreApi = ReturnType<typeof createActivityStore>;
