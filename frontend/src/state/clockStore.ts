/**
 * A coarse "now" for the UI (countdowns, relative times, stale-draft paused state). Components must not call
 * `Date.now()` while rendering (React purity), so they read this store instead; a single interval drives it.
 */
import { createStore } from 'zustand/vanilla';

import type { Scheduler, TimerHandle } from '../lib/scheduler';

/** One tick per second: countdowns show whole seconds (UX section 9.13) and relative times refresh well within 30 s. */
export const CLOCK_TICK_MS = 1000;

export interface ClockState {
  now: number;
  /** Re-reads the time immediately (e.g. right after an action that starts a countdown). */
  tick(): void;
}

export interface ClockStoreApi {
  store: ReturnType<typeof createClockStateStore>;
  start(): void;
  stop(): void;
}

function createClockStateStore(scheduler: Scheduler) {
  return createStore<ClockState>()((set) => ({
    now: scheduler.now(),
    tick: () => {
      set({ now: scheduler.now() });
    },
  }));
}

export function createClockStore(scheduler: Scheduler): ClockStoreApi {
  const store = createClockStateStore(scheduler);
  let handle: TimerHandle | null = null;
  const loop = (): void => {
    store.getState().tick();
    handle = scheduler.setTimeout(loop, CLOCK_TICK_MS);
  };
  return {
    store,
    start(): void {
      if (handle !== null) return;
      loop();
    },
    stop(): void {
      scheduler.clearTimeout(handle);
      handle = null;
    },
  };
}
