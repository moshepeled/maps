import { geodesicArea } from '@snapland/shared';
import { describe, expect, it } from 'vitest';

import { ALICE, BOB } from '../test/factories';
import type { DraftUpdatedLike, RemoteDraftsState } from './remoteDraftsStore';
import {
  EMPTY_REMOTE_DRAFTS,
  createRemoteDraftsStore,
  handleAreaArrived,
  handleDraftEnded,
  handleDraftUpdated,
  isDraftIdle,
  remoteDraftAreaKm2,
  sweepRemoteDrafts,
} from './remoteDraftsStore';

const T0 = 1_790_000_000_000;
const DRAFT = '4b0e1c2d-3e4f-4a5b-8c6d-7e8f9a0b1c2d';

function update(rev: number, user = ALICE, draftId = DRAFT): DraftUpdatedLike {
  return {
    draftId,
    user,
    areaId: null,
    rev,
    vertices: [
      [34.781201, 32.081102],
      [34.785133, 32.081344],
      [34.784977, 32.084621],
    ],
    cursor: [34.781502, 32.084955],
  };
}

describe('remoteDraftsStore - receiver rules (SPEC section 7.6)', () => {
  it('drops a draft with no message for 15 s; keyframes (same rev) keep it alive but it pauses after 10 s', () => {
    let state: RemoteDraftsState = handleDraftUpdated(EMPTY_REMOTE_DRAFTS, update(1), T0);
    state = handleDraftUpdated(state, update(1), T0 + 5000); // keyframe
    const draft = state.drafts.get(DRAFT);
    expect(draft?.lastMessageAt).toBe(T0 + 5000);
    expect(draft !== undefined && isDraftIdle(draft, T0 + 9999)).toBe(false);
    expect(draft !== undefined && isDraftIdle(draft, T0 + 10_000)).toBe(true);
    expect(sweepRemoteDrafts(state, T0 + 5000 + 14_999).drafts.has(DRAFT)).toBe(true);
    expect(sweepRemoteDrafts(state, T0 + 5000 + 15_000).drafts.has(DRAFT)).toBe(false);
  });

  it('ignores an update after draft.ended for the same id for 30 s', () => {
    let state = handleDraftUpdated(EMPTY_REMOTE_DRAFTS, update(1), T0);
    state = handleDraftEnded(
      state,
      { draftId: DRAFT, outcome: 'cancelled', areaId: null },
      T0 + 100,
      () => false,
    );
    expect(state.drafts.has(DRAFT)).toBe(false);
    expect(handleDraftUpdated(state, update(9), T0 + 29_000).drafts.has(DRAFT)).toBe(false);
    state = sweepRemoteDrafts(state, T0 + 100 + 30_000);
    expect(handleDraftUpdated(state, update(10), T0 + 30_200).drafts.has(DRAFT)).toBe(true);
  });

  it('ignores a draft.updated whose user.id differs from the author already held for that id', () => {
    const state = handleDraftUpdated(EMPTY_REMOTE_DRAFTS, update(1, ALICE), T0);
    const hijack = handleDraftUpdated(state, { ...update(2, BOB), vertices: [] }, T0 + 50);
    expect(hijack.drafts.get(DRAFT)?.user.id).toBe(ALICE.id);
    expect(hijack.drafts.get(DRAFT)?.rev).toBe(1);
  });

  it('drops stale revs', () => {
    const state = handleDraftUpdated(EMPTY_REMOTE_DRAFTS, update(5), T0);
    expect(handleDraftUpdated(state, update(4), T0 + 10)).toBe(state);
  });

  it('keeps a committed ghost until its area arrives', () => {
    let state = handleDraftUpdated(EMPTY_REMOTE_DRAFTS, update(3), T0);
    state = handleDraftEnded(
      state,
      { draftId: DRAFT, outcome: 'committed', areaId: DRAFT },
      T0 + 10,
      () => false,
    );
    expect(state.drafts.get(DRAFT)?.committedAt).toBe(T0 + 10);
    // Late relays cannot revive a committed ghost.
    expect(handleDraftUpdated(state, update(4), T0 + 20).drafts.get(DRAFT)?.rev).toBe(3);
    state = handleAreaArrived(state, DRAFT);
    expect(state.drafts.has(DRAFT)).toBe(false);
  });

  it('keeps a committed ghost at most 2 s', () => {
    let state = handleDraftUpdated(EMPTY_REMOTE_DRAFTS, update(3), T0);
    state = handleDraftEnded(
      state,
      { draftId: DRAFT, outcome: 'committed', areaId: DRAFT },
      T0 + 10,
      () => false,
    );
    expect(sweepRemoteDrafts(state, T0 + 1999).drafts.has(DRAFT)).toBe(true);
    expect(sweepRemoteDrafts(state, T0 + 2010).drafts.has(DRAFT)).toBe(false);
  });

  it('removes the ghost at once when the committed area is already in the store', () => {
    let state = handleDraftUpdated(EMPTY_REMOTE_DRAFTS, update(3), T0);
    state = handleDraftEnded(
      state,
      { draftId: DRAFT, outcome: 'committed', areaId: DRAFT },
      T0 + 10,
      () => true,
    );
    expect(state.drafts.has(DRAFT)).toBe(false);
    expect(handleAreaArrived(state, DRAFT)).toBe(state);
  });

  it('computes the live km² from the relayed vertices + cursor', () => {
    const draft = handleDraftUpdated(EMPTY_REMOTE_DRAFTS, update(1), T0).drafts.get(DRAFT);
    expect(draft).toBeDefined();
    if (draft === undefined) return;
    const expected = geodesicArea([[...draft.vertices, draft.cursor ?? [0, 0]]]);
    expect(remoteDraftAreaKm2(draft)).toBe(expected);
    expect(remoteDraftAreaKm2({ vertices: [[0, 0]], cursor: null })).toBe(0);
  });

  it('the zustand wrapper applies transforms and clears in limited mode', () => {
    const store = createRemoteDraftsStore();
    store.getState().update((state) => handleDraftUpdated(state, update(1), T0));
    expect(store.getState().drafts.size).toBe(1);
    store.getState().clear();
    expect(store.getState().drafts.size).toBe(0);
  });
});
