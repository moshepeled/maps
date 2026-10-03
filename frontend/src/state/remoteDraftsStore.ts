/**
 * Other users' live drafts (SPEC section 7.6 "Receivers", UX C-07). Rules:
 * - a draft with no message (update or 5 s keyframe) for 15 s is dropped (covers a lost `draft.ended`);
 * - `draft.updated` for an id that ended in the last 30 s is ignored (cross-instance reordering after a resume);
 * - a `draft.updated` whose `user.id` differs from the author already held for that id is ignored;
 * - on `draft.ended committed` the ghost stays (non-interactive) until its area arrives or 2 s pass (no flicker).
 * Receivers compute the live km² themselves from the relayed 6-dp vertices + cursor.
 */
import type { Position } from '@snapland/shared';
import { geodesicArea } from '@snapland/shared';
import { createStore } from 'zustand/vanilla';

import {
  COMMITTED_GHOST_MAX_MS,
  DRAFT_IDLE_MS,
  DRAFT_STALE_MS,
  ENDED_DRAFT_IGNORE_MS,
} from '../constants/ux';

export interface DraftAuthor {
  id: string;
  displayName: string;
  color: string;
}

export interface RemoteDraft {
  draftId: string;
  user: DraftAuthor;
  /** The area being reshaped, or null for a new area. */
  areaId: string | null;
  rev: number;
  vertices: Position[];
  cursor: Position | null;
  /** Last message of any kind (update or keyframe). */
  lastMessageAt: number;
  /** Last time `rev` changed (paused state after DRAFT_IDLE_MS). */
  lastRevChangeAt: number;
  /** Set when `draft.ended committed` arrived before the area: the ghost waits for it (<= 2 s). */
  committedAt: number | null;
  committedAreaId: string | null;
}

export interface DraftUpdatedLike {
  draftId: string;
  user: DraftAuthor;
  areaId: string | null;
  rev: number;
  vertices: Position[];
  cursor: Position | null;
}

export interface DraftEndedLike {
  draftId: string;
  outcome: 'committed' | 'cancelled' | 'expired' | 'disconnected';
  areaId: string | null;
}

export interface RemoteDraftsState {
  drafts: ReadonlyMap<string, RemoteDraft>;
  /** draftId -> ended at (bounded by the 30 s memory). */
  ended: ReadonlyMap<string, number>;
}

export const EMPTY_REMOTE_DRAFTS: RemoteDraftsState = { drafts: new Map(), ended: new Map() };

export function handleDraftUpdated(
  state: RemoteDraftsState,
  message: DraftUpdatedLike,
  now: number,
): RemoteDraftsState {
  const endedAt = state.ended.get(message.draftId);
  if (endedAt !== undefined && now - endedAt < ENDED_DRAFT_IGNORE_MS) return state;
  const existing = state.drafts.get(message.draftId);
  if (existing !== undefined && existing.user.id !== message.user.id) return state;
  if (existing !== undefined && existing.committedAt !== null) return state;
  if (existing && message.rev < existing.rev) return state;
  // A keyframe repeats the same rev: it proves liveness but is not activity (the paused state keys off rev changes).
  const lastRevChangeAt = existing?.rev === message.rev ? existing.lastRevChangeAt : now;
  const next: RemoteDraft = {
    draftId: message.draftId,
    user: message.user,
    areaId: message.areaId,
    rev: message.rev,
    vertices: message.vertices,
    cursor: message.cursor,
    lastMessageAt: now,
    lastRevChangeAt,
    committedAt: null,
    committedAreaId: null,
  };
  const drafts = new Map(state.drafts);
  drafts.set(message.draftId, next);
  return { ...state, drafts };
}

/**
 * `draft.ended`: remembered for 30 s; a committed draft whose area is not in the store yet keeps its ghost.
 */
export function handleDraftEnded(
  state: RemoteDraftsState,
  message: DraftEndedLike,
  now: number,
  areaKnown: (areaId: string) => boolean,
): RemoteDraftsState {
  const ended = new Map(state.ended);
  ended.set(message.draftId, now);
  const drafts = new Map(state.drafts);
  const existing = drafts.get(message.draftId);
  if (existing !== undefined) {
    const keepGhost =
      message.outcome === 'committed' && message.areaId !== null && !areaKnown(message.areaId);
    if (keepGhost) {
      drafts.set(message.draftId, { ...existing, committedAt: now, committedAreaId: message.areaId });
    } else {
      drafts.delete(message.draftId);
    }
  }
  return { drafts, ended };
}

/** The committed area arrived: its ghost is replaced by the saved shape. */
export function handleAreaArrived(state: RemoteDraftsState, areaId: string): RemoteDraftsState {
  let drafts: Map<string, RemoteDraft> | null = null;
  for (const [draftId, draft] of state.drafts) {
    if (draft.committedAreaId === areaId) {
      drafts ??= new Map(state.drafts);
      drafts.delete(draftId);
    }
  }
  return drafts === null ? state : { ...state, drafts };
}

/** Periodic housekeeping: stale drafts, expired committed ghosts and old ended ids. */
export function sweepRemoteDrafts(state: RemoteDraftsState, now: number): RemoteDraftsState {
  let changed = false;
  const drafts = new Map(state.drafts);
  for (const [draftId, draft] of drafts) {
    const staleGhost = draft.committedAt !== null && now - draft.committedAt >= COMMITTED_GHOST_MAX_MS;
    if (staleGhost || now - draft.lastMessageAt >= DRAFT_STALE_MS) {
      drafts.delete(draftId);
      changed = true;
    }
  }
  const ended = new Map(state.ended);
  for (const [draftId, endedAt] of ended) {
    if (now - endedAt >= ENDED_DRAFT_IGNORE_MS) {
      ended.delete(draftId);
      changed = true;
    }
  }
  return changed ? { drafts, ended } : state;
}

/** Paused (UX C-07): `rev` unchanged for DRAFT_IDLE_MS. */
export function isDraftIdle(draft: RemoteDraft, now: number): boolean {
  return now - draft.lastRevChangeAt >= DRAFT_IDLE_MS;
}

/** The receiver's live km² of a remote draft: relayed vertices + cursor (SPEC section 7.6, section 8.5 parity). */
export function remoteDraftAreaKm2(draft: Pick<RemoteDraft, 'vertices' | 'cursor'>): number {
  const ring = draft.cursor === null ? draft.vertices : [...draft.vertices, draft.cursor];
  return ring.length >= 3 ? geodesicArea([ring]) : 0;
}

// -- zustand wrapper -------------------------------------------------------------------------

export interface RemoteDraftsStore extends RemoteDraftsState {
  update(transform: (state: RemoteDraftsState) => RemoteDraftsState): void;
  /** Limited / offline mode: drafts would be stale (UX F-13 step 3). */
  clear(): void;
}

export function createRemoteDraftsStore() {
  return createStore<RemoteDraftsStore>()((set, get) => ({
    ...EMPTY_REMOTE_DRAFTS,
    update: (transform) => {
      const { drafts, ended } = get();
      const current: RemoteDraftsState = { drafts, ended };
      const next = transform(current);
      if (next !== current) set(next);
    },
    clear: () => {
      set({ drafts: new Map() });
    },
  }));
}

export type RemoteDraftsStoreApi = ReturnType<typeof createRemoteDraftsStore>;
