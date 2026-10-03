/** The live-channel status for the pill (UX C-16) and the E2E hook (`connection.state`, `connection.instanceId`). */
import { createStore } from 'zustand/vanilla';

import type { ConnectionState } from '../realtime/RealtimeClient';

export interface ConnectionStoreState {
  state: ConnectionState;
  instanceId: string | null;
  connectionId: string | null;
  attempt: number;
  nextRetryAt: number | null;
  /** My own colour and name as the server sees them (`welcome.user`). */
  me: { id: string; displayName: string; color: string } | null;
  /** From `welcome.limits` (falls back to `/config`). */
  draftTouchIntervalMs: number | null;
  setState(state: ConnectionState, detail: { attempt: number; nextRetryAt: number | null }): void;
  setWelcome(welcome: {
    instanceId: string;
    connectionId: string;
    me: { id: string; displayName: string; color: string };
    draftTouchIntervalMs: number;
  }): void;
}

export function createConnectionStore() {
  return createStore<ConnectionStoreState>()((set) => ({
    state: 'connecting',
    instanceId: null,
    connectionId: null,
    attempt: 0,
    nextRetryAt: null,
    me: null,
    draftTouchIntervalMs: null,
    setState: (state, detail) => {
      set({ state, attempt: detail.attempt, nextRetryAt: detail.nextRetryAt });
    },
    setWelcome: ({ instanceId, connectionId, me, draftTouchIntervalMs }) => {
      set({ instanceId, connectionId, me, draftTouchIntervalMs });
    },
  }));
}

export type ConnectionStoreApi = ReturnType<typeof createConnectionStore>;
