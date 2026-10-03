import type { PresenceDto } from '@snapland/shared';
import { SERVER_MESSAGE_EXAMPLES } from '@snapland/shared/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createAppStores } from '../app/stores';
import { systemScheduler } from '../lib/scheduler';
import { applyChange, beginRegion } from '../state/areasStore';
import { ALICE, BOB, areaDto, uuid } from '../test/factories';
import type { RealtimeBridgeDeps } from './handlers';
import { createRealtimeHandlers } from './handlers';
import type { ServerMessageOf } from './RealtimeClient';

function example<T extends ServerMessageOf['type']>(type: T): Extract<ServerMessageOf, { type: T }> {
  const found = SERVER_MESSAGE_EXAMPLES.find((message) => message.type === type);
  if (found === undefined) throw new Error(`no example ${type}`);
  return found as Extract<ServerMessageOf, { type: T }>;
}

function presence(userId: string, connectionId: string): PresenceDto {
  return {
    connectionId,
    userId,
    displayName: 'Bob',
    color: BOB.color,
    status: 'viewing',
    activeAreaId: null,
    viewport: null,
    connectedAt: '2026-09-27T10:00:00.000Z',
    updatedAt: '2026-09-27T10:00:00.000Z',
  };
}

function setup() {
  const stores = createAppStores();
  const draft = {
    draftId: null as string | null,
    handleWelcome: vi.fn(),
    handleDisconnected: vi.fn(),
    handleOwnDraftEnded: vi.fn(),
    handleServerError: vi.fn(),
  };
  const deps = {
    stores,
    scheduler: systemScheduler,
    pullFeed: vi.fn<() => Promise<unknown>>().mockResolvedValue('ok'),
    draft,
    presenceApi: { list: vi.fn() },
    reportClientError: vi.fn(),
    restate: vi.fn(),
    onAreaChanged: vi.fn(),
    onBackOnline: vi.fn(),
    reacquireLocks: vi.fn(),
    onSignedOut: vi.fn(),
  } satisfies RealtimeBridgeDeps;
  return { stores, deps, draft, handlers: createRealtimeHandlers(deps) };
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('createRealtimeHandlers (SPEC section 7.5, section 7.12)', () => {
  it('welcome: stores the connection, restates interest, resumes the draft and re-takes locks; no resync on the first connection', () => {
    const { stores, deps, handlers } = setup();
    const welcome = example('welcome').data;
    handlers.onWelcome(welcome, { isReconnect: false, outageMs: null });
    const connection = stores.connection.getState();
    expect(connection.instanceId).toBe('backend-2');
    expect(connection.me?.color).toBe('#b86e3d');
    expect(connection.draftTouchIntervalMs).toBe(20_000);
    expect(deps.restate).toHaveBeenCalledTimes(1);
    expect(deps.draft.handleWelcome).toHaveBeenCalledTimes(1);
    expect(deps.reacquireLocks).toHaveBeenCalledTimes(1);
    expect(deps.pullFeed).not.toHaveBeenCalled();
  });

  it('a reconnect pulls the feed and reports "back online" only after an outage of 10 s or more (UX F-13 step 6)', async () => {
    const { deps, handlers } = setup();
    const welcome = example('welcome').data;
    handlers.onWelcome(welcome, { isReconnect: true, outageMs: 4000 });
    await vi.advanceTimersByTimeAsync(0);
    expect(deps.pullFeed).toHaveBeenCalledTimes(1);
    expect(deps.onBackOnline).not.toHaveBeenCalled();
    handlers.onWelcome(welcome, { isReconnect: true, outageMs: 12_000 });
    await vi.advanceTimersByTimeAsync(0);
    expect(deps.onBackOnline).toHaveBeenCalledWith(12_000);
  });

  it('presence snapshot / joined / updated / left and lock snapshot / changed update their stores', () => {
    const { stores, handlers } = setup();
    handlers.onMessage(example('presence.snapshot'));
    expect(stores.presence.getState().entries.size).toBe(1);
    expect(stores.presence.getState().source).toBe('ws');
    const connectionId = uuid();
    handlers.onMessage({ type: 'presence.joined', data: { presence: presence(BOB.id, connectionId) } });
    expect(stores.presence.getState().entries.size).toBe(2);
    handlers.onMessage({ type: 'presence.left', data: { connectionId, userId: BOB.id } });
    expect(stores.presence.getState().entries.size).toBe(1);
    handlers.onMessage(example('lock.snapshot'));
    expect(stores.locks.getState().known).toBe(true);
    expect(stores.locks.getState().locks.size).toBe(1);
    handlers.onMessage({
      type: 'lock.changed',
      data: { areaId: '7d7a4c52-9a0b-4e0f-b3c1-2e5f6a7b8c9d', holder: null, scope: null, expiresAt: null },
    });
    expect(stores.locks.getState().locks.size).toBe(0);
  });

  it('area.changed goes to the workspace and replaces a committed ghost', () => {
    const { stores, deps, handlers } = setup();
    const draftId = '4b0e1c2d-3e4f-4a5b-8c6d-7e8f9a0b1c2d';
    handlers.onMessage(example('draft.updated'));
    handlers.onMessage({
      type: 'draft.ended',
      data: { draftId, userId: ALICE.id, outcome: 'committed', areaId: draftId },
    });
    expect(stores.remoteDrafts.getState().drafts.get(draftId)?.committedAt).not.toBeNull();
    const area = areaDto({ id: draftId });
    handlers.onMessage({
      type: 'area.changed',
      data: {
        changeSeq: 2,
        op: 'create',
        area,
        changedFields: [],
        merged: false,
        previousName: null,
        actor: ALICE,
      },
    });
    expect(deps.onAreaChanged).toHaveBeenCalledTimes(1);
    expect(stores.remoteDrafts.getState().drafts.has(draftId)).toBe(false);
  });

  it('draft.updated / draft.ended of my own draft go to the draft session, others to the remote drafts store', () => {
    const { stores, draft, handlers } = setup();
    const mine = '4b0e1c2d-3e4f-4a5b-8c6d-7e8f9a0b1c2d';
    draft.draftId = mine;
    handlers.onMessage(example('draft.updated'));
    expect(stores.remoteDrafts.getState().drafts.size).toBe(0);
    handlers.onMessage({
      type: 'draft.ended',
      data: { draftId: mine, userId: ALICE.id, outcome: 'expired', areaId: null },
    });
    expect(draft.handleOwnDraftEnded).toHaveBeenCalledWith(mine, 'expired');
    draft.draftId = null;
    handlers.onMessage(example('draft.updated'));
    expect(stores.remoteDrafts.getState().drafts.size).toBe(1);
    handlers.onMessage({
      type: 'draft.ended',
      data: { draftId: mine, userId: ALICE.id, outcome: 'cancelled', areaId: null },
    });
    expect(stores.remoteDrafts.getState().drafts.size).toBe(0);
  });

  it('a ref-less error reaches the draft session; resync.required and anti-entropy pull the feed; acks are ignored', async () => {
    const { deps, draft, handlers } = setup();
    handlers.onMessage({ type: 'error', data: { code: 'DRAFT_NOT_FOUND', message: 'gone' } });
    expect(draft.handleServerError).toHaveBeenCalledTimes(1);
    handlers.onMessage(example('resync.required'));
    handlers.onAntiEntropy();
    await vi.advanceTimersByTimeAsync(0);
    expect(deps.pullFeed).toHaveBeenCalledTimes(2);
    handlers.onMessage({ type: 'ack', data: {} });
    handlers.onMessage({ type: 'pong', data: { t: 1, serverTime: 2 } });
  });

  function liveWithCollaborators(): ReturnType<typeof setup> {
    const context = setup();
    context.handlers.onWelcome(example('welcome').data, { isReconnect: false, outageMs: null });
    context.handlers.onState('live', { attempt: 0, nextRetryAt: null });
    context.handlers.onMessage(example('draft.updated'));
    context.handlers.onMessage(example('lock.snapshot'));
    return context;
  }

  it('limited: the channel closed -> the draft goes local; remote drafts and lock badges are cleared (UX F-13 step 3)', () => {
    const { stores, draft, handlers } = liveWithCollaborators();
    handlers.onChannelLost();
    expect(draft.handleDisconnected).toHaveBeenCalledTimes(1);
    handlers.onState('reconnecting', { attempt: 1, nextRetryAt: null });
    expect(stores.locks.getState().known).toBe(true); // a blip keeps them
    handlers.onState('limited', { attempt: 3, nextRetryAt: null });
    expect(stores.connection.getState().state).toBe('limited');
    expect(stores.remoteDrafts.getState().drafts.size).toBe(0);
    expect(stores.locks.getState().known).toBe(false);
  });

  it('QA-T5-06: a browser offline -> online blip on an open socket keeps my draft claim, remote drafts and badges', () => {
    const { stores, draft, handlers } = liveWithCollaborators();
    const drafts = stores.remoteDrafts.getState().drafts.size;
    handlers.onState('offline', { attempt: 0, nextRetryAt: null });
    handlers.onState('live', { attempt: 0, nextRetryAt: null });
    expect(draft.handleDisconnected).not.toHaveBeenCalled();
    expect(stores.remoteDrafts.getState().drafts.size).toBe(drafts);
    expect(stores.locks.getState().known).toBe(true);
  });

  it('the socket closing while already offline clears what would otherwise stay stale', () => {
    const { stores, draft, handlers } = liveWithCollaborators();
    handlers.onState('offline', { attempt: 0, nextRetryAt: null });
    expect(stores.locks.getState().known).toBe(true);
    handlers.onChannelLost(); // e.g. the 45 s liveness timeout
    expect(draft.handleDisconnected).toHaveBeenCalledTimes(1);
    expect(stores.remoteDrafts.getState().drafts.size).toBe(0);
    expect(stores.locks.getState().known).toBe(false);
  });

  it('limited-mode polls: the feed outcome decides REST health; presence comes from GET /presence without status', async () => {
    const { stores, deps, handlers } = setup();
    await expect(handlers.onPollChanges()).resolves.toBe(true);
    deps.pullFeed.mockRejectedValueOnce(new Error('down'));
    await expect(handlers.onPollChanges()).resolves.toBe(false);
    deps.presenceApi.list.mockResolvedValueOnce({
      items: [presence(BOB.id, uuid())],
      onlineCount: 1,
      truncated: false,
    });
    await handlers.onPollPresence();
    expect(stores.presence.getState().source).toBe('rest');
    deps.presenceApi.list.mockRejectedValueOnce(new Error('down'));
    await handlers.onPollPresence();
    expect(stores.presence.getState().entries.size).toBe(1);
  });

  it('client errors are forwarded; sign-out is delegated', () => {
    const { deps, handlers } = setup();
    handlers.reportClientError({ kind: 'ws_close', code: 4400, message: 'closed' });
    expect(deps.reportClientError).toHaveBeenCalledWith({
      kind: 'ws_close',
      code: 4400,
      message: 'closed',
      context: undefined,
    });
    handlers.onSignedOut();
    expect(deps.onSignedOut).toHaveBeenCalledTimes(1);
  });

  it('keeps unknown-area bookkeeping for the committed-ghost rule', () => {
    const { stores, handlers } = setup();
    const id = uuid();
    stores.areas
      .getState()
      .update((state) => beginRegion(state, { id: 1, bbox: [34, 31, 35, 33], zoom: 12 }));
    stores.areas
      .getState()
      .update((state) => applyChange(state, { op: 'create', area: areaDto({ id }) }, 0).state);
    handlers.onMessage({
      type: 'draft.updated',
      data: {
        draftId: id,
        user: { id: BOB.id, displayName: 'Bob', color: BOB.color },
        areaId: null,
        rev: 1,
        vertices: [],
        cursor: null,
      },
    });
    handlers.onMessage({
      type: 'draft.ended',
      data: { draftId: id, userId: BOB.id, outcome: 'committed', areaId: id },
    });
    expect(stores.remoteDrafts.getState().drafts.has(id)).toBe(false);
  });
});
