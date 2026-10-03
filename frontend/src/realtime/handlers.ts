/**
 * Server message -> store actions (SPEC section 8.6 `realtime/handlers.ts`, section 7.5, section 7.12): the `RealtimeHandlers` the
 * `RealtimeClient` calls. Kept free of React and Leaflet; the workspace-level reactions to committed changes
 * (collaboration toasts, early warnings, the deleted-while-editing dialog) are injected as `onAreaChanged`.
 */
import type { ServerMessageOf as SharedServerMessageOf } from '@snapland/shared';

import type { PresenceApi } from '../api/endpoints';
import type { AppStores } from '../app/stores';
import { WS_DEGRADE_AFTER_MS } from '../constants/ux';
import type { Scheduler } from '../lib/scheduler';
import { handleAreaArrived, handleDraftEnded, handleDraftUpdated } from '../state/remoteDraftsStore';
import type { ClientErrorInput } from './clientErrors';
import type { DraftSession } from './draftSession';
import type { ConnectionState, RealtimeHandlers, ServerMessageOf, WelcomeData } from './RealtimeClient';

export type AreaChangedData = SharedServerMessageOf<'area.changed'>['data'];

export interface RealtimeBridgeDeps {
  stores: Pick<AppStores, 'connection' | 'presence' | 'locks' | 'remoteDrafts' | 'areas'>;
  scheduler: Scheduler;
  /** Change-feed pull (resync, anti-entropy, limited-mode polling). Resolves 'ok' | 'reload'; rejects when REST fails. */
  pullFeed(): Promise<unknown>;
  draft: Pick<
    DraftSession,
    'draftId' | 'handleWelcome' | 'handleDisconnected' | 'handleOwnDraftEnded' | 'handleServerError'
  >;
  presenceApi: PresenceApi;
  reportClientError(input: ClientErrorInput): void;
  /** Restates my interest and status after every `welcome` (SPEC section 7.12 step 3). */
  restate(): void;
  /** A committed change arrived over the live channel (store already updated). */
  onAreaChanged(data: AreaChangedData): void;
  /** Called after the post-reconnect resync, when the outage was long enough to report (UX F-13 step 6). */
  onBackOnline(outageMs: number): void;
  /** Soft locks of this connection are gone after a reconnect: take them again (SPEC section 7.9). */
  reacquireLocks(): void;
  onSignedOut(): void;
}

/** States in which the app has no live channel to keep remote drafts and lock badges current (UX F-13 step 3). */
function lacksLiveChannel(state: ConnectionState): boolean {
  return state === 'limited' || state === 'offline' || state === 'signed-out';
}

export function createRealtimeHandlers(deps: RealtimeBridgeDeps): RealtimeHandlers {
  const { stores } = deps;
  const areaKnown = (areaId: string): boolean => stores.areas.getState().byId.has(areaId);
  /**
   * A welcomed socket is open. The browser `offline` event does not close it: while it stays open the server keeps
   * streaming keyframes and lock changes, so nothing it owns is dropped until it actually closes.
   */
  let channelOpen = false;

  const clearLiveOnlyState = (): void => {
    // Remote drafts and lock badges would be stale without the live channel (UX F-13 step 3).
    stores.remoteDrafts.getState().clear();
    stores.locks.getState().clear();
  };

  const onWelcome = (welcome: WelcomeData, info: { isReconnect: boolean; outageMs: number | null }): void => {
    channelOpen = true;
    stores.connection.getState().setWelcome({
      instanceId: welcome.instanceId,
      connectionId: welcome.connectionId,
      me: welcome.user,
      draftTouchIntervalMs: welcome.limits.draftTouchIntervalMs,
    });
    deps.restate();
    deps.draft.handleWelcome();
    deps.reacquireLocks();
    if (!info.isReconnect) return;
    // Resync (SPEC section 7.12 steps 3-4): the feed from restCursor repairs everything missed while disconnected.
    void deps
      .pullFeed()
      .then(() => {
        if (info.outageMs !== null && info.outageMs >= WS_DEGRADE_AFTER_MS) deps.onBackOnline(info.outageMs);
      })
      .catch(() => undefined);
  };

  const onMessage = (message: ServerMessageOf): void => {
    const now = deps.scheduler.now();
    switch (message.type) {
      case 'presence.snapshot':
        stores.presence
          .getState()
          .snapshot(message.data.items, message.data.onlineCount, message.data.truncated, 'ws');
        return;
      case 'presence.joined':
      case 'presence.updated':
        stores.presence.getState().upsert(message.data.presence);
        return;
      case 'presence.left':
        stores.presence.getState().remove(message.data.connectionId);
        return;
      case 'lock.snapshot':
        stores.locks.getState().snapshot(message.data.items);
        return;
      case 'lock.changed':
        stores.locks.getState().changed(message.data);
        return;
      case 'area.changed':
        deps.onAreaChanged(message.data);
        stores.remoteDrafts.getState().update((state) => handleAreaArrived(state, message.data.area.id));
        return;
      case 'draft.updated':
        if (message.data.draftId === deps.draft.draftId) return;
        stores.remoteDrafts.getState().update((state) => handleDraftUpdated(state, message.data, now));
        return;
      case 'draft.ended':
        if (message.data.draftId === deps.draft.draftId) {
          deps.draft.handleOwnDraftEnded(message.data.draftId, message.data.outcome);
          return;
        }
        stores.remoteDrafts
          .getState()
          .update((state) => handleDraftEnded(state, message.data, now, areaKnown));
        return;
      case 'error':
        deps.draft.handleServerError(message.data);
        return;
      case 'resync.required':
        void deps.pullFeed().catch(() => undefined);
        return;
      case 'ack':
      case 'lock.acquired':
      case 'welcome':
      case 'pong':
        // Replies without a pending request (e.g. a timed-out ref) carry nothing to apply.
        return;
    }
  };

  const onState = (state: ConnectionState, detail: { attempt: number; nextRetryAt: number | null }): void => {
    const previous = stores.connection.getState().state;
    stores.connection.getState().setState(state, detail);
    if (state === previous) return;
    if (lacksLiveChannel(state) && !channelOpen) clearLiveOnlyState();
  };

  /** Only a real socket close ends my draft claim; an `offline` -> `online` blip on an open socket keeps sharing. */
  const onChannelLost = (): void => {
    channelOpen = false;
    deps.draft.handleDisconnected();
    if (lacksLiveChannel(stores.connection.getState().state)) clearLiveOnlyState();
  };

  return {
    onState,
    onWelcome,
    onChannelLost,
    onMessage,
    onSignedOut: () => {
      deps.onSignedOut();
    },
    onPollChanges: () =>
      deps.pullFeed().then(
        () => true,
        () => false,
      ),
    onPollPresence: async () => {
      try {
        const response = await deps.presenceApi.list();
        stores.presence.getState().snapshot(response.items, response.onlineCount, response.truncated, 'rest');
      } catch {
        // The change-feed poll decides between limited and offline; a failed presence poll just keeps the last list.
      }
    },
    onAntiEntropy: () => {
      void deps.pullFeed().catch(() => undefined);
    },
    reportClientError: (input) => {
      deps.reportClientError({
        kind: input.kind,
        code: input.code,
        message: input.message,
        context: input.context,
      });
    },
  };
}
