/**
 * Short-lived map effects (UX C-08): the pulse in the actor's colour after someone else changed an area (or, with
 * reduced motion, a static ring + "{user}, updated" chip), and my own pending saves (the Saving style / E2E
 * `flags.pending`).
 */
import { createStore } from 'zustand/vanilla';

export interface Pulse {
  areaId: string;
  /**
   * The actor's colour, or null for a change without an actor (system): the map then pulses in the neutral saved-area
   * colour of the current map tone (`--ov-area-stroke`), which only the map can resolve (UX section 6.2, UI.md section 2.5).
   */
  color: string | null;
  userId: string | null;
  userName: string | null;
  until: number;
  /** Reduced motion: a static ring + chip instead of the animation. */
  staticRing: boolean;
}

export interface EffectsState {
  pulses: ReadonlyMap<string, Pulse>;
  /** Areas whose save (create or edit) is in flight from this client. */
  pending: ReadonlySet<string>;
  /** Areas hidden optimistically (a delete in flight or counting down, UX F-06 step 2). */
  hidden: ReadonlySet<string>;
  addPulse(pulse: Pulse): void;
  removePulse(areaId: string): void;
  setPending(areaId: string, pending: boolean): void;
  setHidden(areaId: string, hidden: boolean): void;
}

export function createEffectsStore() {
  return createStore<EffectsState>()((set, get) => ({
    pulses: new Map(),
    pending: new Set(),
    hidden: new Set(),
    addPulse: (pulse) => {
      const pulses = new Map(get().pulses);
      pulses.set(pulse.areaId, pulse);
      set({ pulses });
    },
    removePulse: (areaId) => {
      if (!get().pulses.has(areaId)) return;
      const pulses = new Map(get().pulses);
      pulses.delete(areaId);
      set({ pulses });
    },
    setPending: (areaId, pending) => {
      const next = new Set(get().pending);
      if (pending) next.add(areaId);
      else next.delete(areaId);
      set({ pending: next });
    },
    setHidden: (areaId, hidden) => {
      if (get().hidden.has(areaId) === hidden) return;
      const next = new Set(get().hidden);
      if (hidden) next.add(areaId);
      else next.delete(areaId);
      set({ hidden: next });
    },
  }));
}

export type EffectsStoreApi = ReturnType<typeof createEffectsStore>;
