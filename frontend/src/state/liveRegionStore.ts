/**
 * The three screen-reader live regions (UX section 6.6): `status` (polite: my results, drawing events, mode and layer
 * changes), `collab` (log: batched collaboration events, <= 1 per 30 s, held while working, silent in Quiet mode) and
 * `alert` (assertive: errors about my work; identical consecutive messages are not repeated). Messages within 250 ms
 * are coalesced by the LiveRegions component.
 */
import { createStore } from 'zustand/vanilla';

export interface Announcement {
  text: string;
  /** Increments on every announcement so an identical text is re-announced when allowed. */
  seq: number;
}

export interface LiveRegionState {
  status: Announcement;
  collab: Announcement;
  alert: Announcement;
  announce(region: 'status' | 'collab' | 'alert', text: string): void;
}

export function createLiveRegionStore() {
  return createStore<LiveRegionState>()((set, get) => ({
    status: { text: '', seq: 0 },
    collab: { text: '', seq: 0 },
    alert: { text: '', seq: 0 },
    announce: (region, text) => {
      const current = get()[region];
      if (region === 'alert' && current.text === text) return;
      set({ [region]: { text, seq: current.seq + 1 } });
    },
  }));
}

export type LiveRegionStoreApi = ReturnType<typeof createLiveRegionStore>;
