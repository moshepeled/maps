/**
 * The map workspace of one signed-in user (UX section 3, SPEC section 8.6): builds the realtime client, the draft session, the
 * area sync engine and every flow, wires them to the stores, and exposes the commands the React components and the
 * map controller call. Created on sign-in, disposed on sign-out or when another user signs in.
 */
import type { Bbox, ChangedField, UserRef } from '@snapland/shared';
import { REALTIME, bboxesIntersect } from '@snapland/shared';

import { postClientError } from '../api/endpoints';
import { isApiError } from '../api/http';
import { navigate } from '../app/router';
import type { AppServices } from '../app/services';
import { resetUserStores } from '../app/stores';
import {
  KEY_MOVE_POINT_FINE_PX,
  KEY_MOVE_POINT_PX,
  KEY_PAN_FINE_PX,
  KEY_PAN_PX,
  TOAST_UNDO_MS,
} from '../constants/ux';
import { base, wait } from '../base/en';
import { newId } from '../lib/ids';
import { displayUser } from '../lib/text';
import type { Scheduler } from '../lib/scheduler';
import { createDebounce } from '../lib/throttle';
import { ClientErrorReporter } from '../realtime/clientErrors';
import type { SharingStatus } from '../realtime/draftSession';
import { DraftSession } from '../realtime/draftSession';
import type { AreaChangedData } from '../realtime/handlers';
import { createRealtimeHandlers } from '../realtime/handlers';
import type { SocketLike, TicketResult } from '../realtime/RealtimeClient';
import { RealtimeClient } from '../realtime/RealtimeClient';
import type { ChangeLike, ChangeOutcome } from '../state/areasStore';
import { applyChange } from '../state/areasStore';
import { sweepRemoteDrafts } from '../state/remoteDraftsStore';
import type { ListPage } from '../state/areasSync';
import { AreasSync } from '../state/areasSync';
import { isDirty } from '../state/editReducer';
import type { LocalDraft } from '../state/localDraft';
import {
  loadDevicePrefs,
  loadLocalDraft,
  loadViewPreference,
  markLocalDraftDiscarded,
  saveDevicePrefs,
  saveLocalDraft,
  saveViewPreference,
} from '../state/localDraft';
import type { BaseLayerId, LayerChoice } from '../state/mapViewStore';
import { resolveBaseLayer, toggledChoice } from '../state/mapViewStore';
import type { RegionLoadPerf, FailureClass } from '../map/viewportSync';
import { ViewportSync } from '../map/viewportSync';
import { draftTouchIntervalMs, draftUpdateIntervalMs, bboxMaxSpanPx } from '../state/runtimeConfigStore';
import { hasAreaInView } from '../state/selectors';
import type { Mode } from '../state/workspaceStore';
import { modalOpen, offersEmptyHint, sectionExpanded } from '../state/workspaceStore';
import { AreaFlow } from './areaFlow';
import { CollabNotifier } from './collabNotifier';
import { ConflictFlow } from './conflictFlow';
import type { MapBridge, WorkspaceContext } from './context';
import { announce, awaitsSignIn, showToast } from './context';
import { DrawingFlow } from './drawingFlow';
import { EditFlow } from './editFlow';
import type { GlobalCommand, KeyInput, MapCommand } from './keyboard';
import { isTypingTarget, resolveGlobalKey, resolveMapKey } from './keyboard';
import { LockKeeper } from './lockKeeper';
import { OwnWrites } from './ownWrites';

/** Browser capabilities the workspace uses (injected so tests can run it without a browser). */
export interface WorkspaceEnv {
  openSocket(ticket: string): SocketLike;
  isOnline(): boolean;
  random(): number;
  reducedMotion(): boolean;
  isPhone(): boolean;
  /** `VITE_ENABLE_ITM_LAYER`: *Aerial* is the GovMap ITM cache, else Esri World Imagery (SPEC section 8.3). */
  itmLayerEnabled: boolean;
  appVersion: string;
}

class BrowserSocket implements SocketLike {
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onclose: ((event: { code: number; reason: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  private readonly socket: WebSocket;

  constructor(url: string) {
    this.socket = new WebSocket(url, [REALTIME.subprotocol]);
    this.socket.onopen = () => this.onopen?.();
    this.socket.onmessage = (event: MessageEvent<unknown>) => this.onmessage?.({ data: event.data });
    this.socket.onclose = (event: CloseEvent) => this.onclose?.({ code: event.code, reason: event.reason });
    this.socket.onerror = () => this.onerror?.();
  }

  send(data: string): void {
    if (this.socket.readyState === WebSocket.OPEN) this.socket.send(data);
  }

  close(code?: number, reason?: string): void {
    this.socket.close(code, reason);
  }
}

/** `ws(s)://<host>/ws?ticket=...` on the page origin (the Vite proxy / nginx forward it, SPEC section 7.1). */
export function socketUrl(ticket: string, location: Pick<Location, 'protocol' | 'host'>): string {
  const scheme = location.protocol === 'https:' ? 'wss' : 'ws';
  return `${scheme}://${location.host}${REALTIME.wsPath}?ticket=${encodeURIComponent(ticket)}`;
}

export function browserEnv(options: Pick<WorkspaceEnv, 'itmLayerEnabled' | 'appVersion'>): WorkspaceEnv {
  return {
    openSocket: (ticket) => new BrowserSocket(socketUrl(ticket, globalThis.location)),
    isOnline: () => globalThis.navigator.onLine,
    random: () => Math.random(),
    reducedMotion: () => globalThis.matchMedia('(prefers-reduced-motion: reduce)').matches,
    isPhone: () => globalThis.matchMedia('(max-width: 599.98px)').matches,
    ...options,
  };
}

/** How often expired remote drafts are swept (well under the 2 s committed-ghost cap). */
const REMOTE_DRAFT_SWEEP_MS = 500;

export interface LastRegionLoad {
  pages: number;
  items: number;
  bytes: number;
  culledCount: number | null;
  fetchMs: number;
  renderMs: number;
}

export class Workspace {
  readonly ctx: WorkspaceContext;
  readonly realtime: RealtimeClient;
  readonly draft: DraftSession;
  readonly sync: AreasSync;
  readonly viewportSync: ViewportSync;
  readonly locks: LockKeeper;
  readonly drawing: DrawingFlow;
  readonly area: AreaFlow;
  readonly edit: EditFlow;
  readonly conflict: ConflictFlow;
  readonly collab: CollabNotifier;
  lastRegionLoad: LastRegionLoad | null = null;

  private mapBridge: MapBridge | null = null;
  private readonly unsubscribers: (() => void)[] = [];
  /** Tells this tab's own echoes apart from my changes made elsewhere (UX C-14, C-20). */
  private readonly ownWrites = new OwnWrites();
  private readonly clientErrors: ClientErrorReporter;
  private pendingAfterSignIn: (() => void) | null = null;
  /** The view's load failed because the session ended: it reloads once the user signs in again. */
  private viewAwaitsSignIn = false;
  private lastViewport: { bbox: Bbox; zoom: number } | null = null;
  /** The areas in view that someone else changed while my live channel was down (the back-online toast counts them). */
  private readonly changedWhileAway = new Set<string>();
  private readonly scheduler: Scheduler;
  private started = false;
  /**
   * The user this workspace belongs to (bound at `start()`). Local drafts and view preferences are written for this id
   * only - never for whoever the auth store names by the time a debounced write fires or the workspace is disposed.
   */
  private userId: string | null = null;

  constructor(
    private readonly services: AppServices,
    private readonly env: WorkspaceEnv,
  ) {
    const { stores } = services;
    this.scheduler = services.scheduler;
    this.clientErrors = new ClientErrorReporter({
      scheduler: this.scheduler,
      appVersion: env.appVersion,
      post: (report) => postClientError(services.http, report),
    });

    const transport = {
      send: (message: Parameters<RealtimeClient['send']>[0]) => this.realtime.send(message),
      request: (message: Parameters<RealtimeClient['request']>[0]) => this.realtime.request(message),
      get isLive() {
        return realtimeRef.current?.isLive ?? false;
      },
      get connectionState() {
        return realtimeRef.current?.connectionState ?? 'connecting';
      },
    };
    const realtimeRef: { current: RealtimeClient | null } = { current: null };

    this.draft = new DraftSession({
      transport,
      scheduler: this.scheduler,
      newId,
      touchIntervalMs: () =>
        stores.connection.getState().draftTouchIntervalMs ??
        draftTouchIntervalMs(stores.runtime.getState().config),
      updateIntervalMs: () => draftUpdateIntervalMs(stores.runtime.getState().config),
      onStatus: (status) => {
        this.onSharingStatus(status);
      },
    });

    this.ctx = {
      stores,
      clock: services.clock.store,
      api: { areas: this.ownWrites.wrap(services.api.areas), auth: services.api.auth },
      realtime: transport,
      draft: this.draft,
      scheduler: this.scheduler,
      newId,
      map: () => this.mapBridge,
      reducedMotion: () => env.reducedMotion(),
      isPhone: () => env.isPhone(),
    };

    this.sync = new AreasSync({
      store: stores.areas,
      api: {
        listBbox: (params, signal): Promise<ListPage> => services.api.areas.listBbox(params, signal),
        changes: (params, signal) => services.api.areas.changes(params, signal),
      },
      scheduler: this.scheduler,
      onChange: (change, outcome) => {
        this.onFeedChange(change, outcome);
      },
      viewport: () => this.viewportSync.current(),
    });

    this.viewportSync = new ViewportSync({
      sync: this.sync,
      store: stores.areas,
      scheduler: this.scheduler,
      sendViewport: (bbox, zoom) => {
        this.lastViewport = { bbox, zoom };
        this.realtime.send({
          type: 'viewport.set',
          data: { bbox, zoom: Math.max(0, Math.min(22, Math.round(zoom))) },
        });
      },
      onLoadState: (load) => {
        stores.notices.getState().patch({ load });
        this.updateEmptyView();
      },
      onPerf: (perf: RegionLoadPerf) => {
        this.lastRegionLoad = { ...perf, renderMs: 0 };
      },
      classifyError: (error): FailureClass => {
        if (isApiError(error, 'ABORTED') || (error instanceof DOMException && error.name === 'AbortError'))
          return { kind: 'aborted' };
        // The session ended: the dialog is up, so this is no load error; the view reloads once signed in (F-11 step 4).
        if (awaitsSignIn(this.ctx, error)) {
          this.viewAwaitsSignIn = true;
          return { kind: 'aborted' };
        }
        if (isApiError(error) && error.status === 429)
          return { kind: 'rate-limited', retryAfterMs: error.retryAfterMs ?? 5000 };
        if (isApiError(error) && error.status === 503)
          return { kind: 'storage', retryAfterMs: error.retryAfterMs ?? 5000 };
        return { kind: 'error' };
      },
      maxSpanPx: () => bboxMaxSpanPx(stores.runtime.getState().config),
    });

    this.locks = new LockKeeper(this.ctx);
    this.collab = new CollabNotifier(this.ctx, () => stores.mapView.getState().viewport);
    const retryAfterSignIn = (action: () => void): void => {
      this.pendingAfterSignIn = action;
    };
    this.area = new AreaFlow(this.ctx, this.locks, {
      lastActor: (areaId) => this.collab.lastActor(areaId),
      openDetailsConflict: (areaId, mine, error) => {
        this.conflict.openDetails(areaId, mine, error);
      },
      saveCopy: (points, name, description) => {
        this.drawing.startNamingWith(points, name, description);
      },
      retryAfterSignIn,
    });
    this.drawing = new DrawingFlow(this.ctx, {
      onSaved: (area, viaKeyboard) => {
        this.area.showSaved(area, viaKeyboard);
      },
      retryAfterSignIn,
    });
    this.edit = new EditFlow(this.ctx, this.locks, {
      showSaved: (area, viaKeyboard) => {
        this.area.showSaved(area, viaKeyboard);
      },
      mergedToast: (area, theirs, mine) => {
        this.area.mergedToast(area, theirs, mine);
      },
      openShapeConflict: (areaId, rings, error) => {
        this.conflict.openShape(areaId, rings, error);
      },
      openDeletedWhileEditing: (current) => {
        this.conflict.openDeletedWhileEditing(current);
      },
      retryAfterSignIn,
    });
    this.conflict = new ConflictFlow(this.ctx, this.area, this.edit);

    this.realtime = new RealtimeClient({
      scheduler: this.scheduler,
      random: () => env.random(),
      fetchTicket: () => this.fetchTicket(),
      refreshSession: async () => (await services.session.refresh()).ok,
      openSocket: (ticket) => env.openSocket(ticket),
      isOnline: () => env.isOnline(),
      handlers: createRealtimeHandlers({
        stores,
        scheduler: this.scheduler,
        pullFeed: () => this.sync.pullFeed(),
        draft: this.draft,
        presenceApi: services.api.presence,
        reportClientError: (input) => {
          this.clientErrors.report(input);
        },
        restate: () => {
          this.restate();
        },
        onAreaChanged: (data) => {
          this.onAreaChanged(data);
        },
        onBackOnline: () => {
          this.backOnlineToast();
        },
        reacquireLocks: () => {
          this.locks.reacquireAll();
        },
        onSignedOut: () => undefined,
      }),
    });
    realtimeRef.current = this.realtime;
  }

  // -- lifecycle -----------------------------------------------------------------------------

  start(): void {
    if (this.started) return;
    this.started = true;
    const { stores } = this.services;
    // The frame layout describes this device's screen, not the user: it survives the reset below (the view has
    // already written it from its media queries before this runs).
    const layout = stores.workspace.getState().layout;
    // A fresh workspace starts from a clean slate: nothing of a previous user (or a previous session) carries over.
    resetUserStores(stores);
    const user = stores.auth.getState().user;
    this.userId = user?.id ?? null;
    const prefs = loadDevicePrefs();
    stores.workspace
      .getState()
      .patch({ quietMode: prefs.quietMode, singleKeyShortcuts: prefs.singleKeyShortcuts, layout });
    if (user !== null) {
      const view = loadViewPreference(user.id);
      const choice = view?.choice ?? 'map';
      const baseLayer = resolveBaseLayer(choice, this.env.itmLayerEnabled);
      stores.mapView.setState({
        choice,
        baseLayer,
        displayedBaseLayer: baseLayer,
        ...(view === null ? {} : { center: view.center, zoom: view.zoom, mercatorZoom: view.zoom }),
      });
      const draft = loadLocalDraft(user.id, this.scheduler.now());
      if (draft !== null) {
        stores.workspace.getState().patch({ localDraft: draft });
        stores.notices.getState().patch({ restoreDraft: true });
      }
    }
    this.subscribe();
    this.realtime.start();
    this.listenToBrowser();
  }

  dispose(): void {
    this.realtime.stop();
    this.viewportSync.dispose();
    this.draft.dispose();
    this.drawing.dispose();
    this.area.dispose();
    this.edit.dispose();
    this.collab.dispose();
    this.locks.releaseAll();
    for (const unsubscribe of this.unsubscribers.splice(0)) unsubscribe();
    this.mapBridge = null;
    // React StrictMode mounts, unmounts and mounts again: the workspace must be startable after a dispose.
    this.started = false;
  }

  attachMap(bridge: MapBridge | null): void {
    this.mapBridge = bridge;
  }

  /** Signed in again after the session dialog (UX F-11 step 4): reconnect and retry the failed request once. */
  onSignedInAgain(): void {
    this.realtime.start();
    const pending = this.pendingAfterSignIn;
    this.pendingAfterSignIn = null;
    pending?.();
    if (this.viewAwaitsSignIn) {
      this.viewAwaitsSignIn = false;
      this.viewportSync.retry();
    }
  }

  private async fetchTicket(): Promise<TicketResult> {
    try {
      return { ok: true, ticket: await this.services.api.auth.wsTicket() };
    } catch (error) {
      if (isApiError(error, 'SESSION_ENDED')) return { ok: false, reason: 'session-ended' };
      if (isApiError(error) && (error.kind === 'network' || error.kind === 'timeout'))
        return { ok: false, reason: 'network' };
      if (!isApiError(error)) return { ok: false, reason: 'network' };
      return { ok: false, reason: 'other' };
    }
  }

  /** After `welcome`: my interest and status (SPEC section 7.12 step 3). */
  private restate(): void {
    if (this.lastViewport !== null) {
      this.realtime.send({
        type: 'viewport.set',
        data: {
          bbox: this.lastViewport.bbox,
          zoom: Math.max(0, Math.min(22, Math.round(this.lastViewport.zoom))),
        },
      });
    }
    this.realtime.send({ type: 'presence.update', data: { status: 'viewing' } });
  }

  private listenToBrowser(): void {
    const online = (): void => {
      this.realtime.handleOnline();
    };
    const offline = (): void => {
      this.realtime.handleOffline();
    };
    const visible = (): void => {
      if (document.visibilityState === 'visible') this.realtime.retryNow();
    };
    const unhandled = (event: PromiseRejectionEvent): void => {
      const reason: unknown = event.reason;
      this.clientErrors.report({
        kind: 'unhandled',
        message: reason instanceof Error ? reason.message : String(reason),
      });
    };
    const error = (event: ErrorEvent): void => {
      this.clientErrors.report({ kind: 'unhandled', message: event.message });
    };
    globalThis.addEventListener('online', online);
    globalThis.addEventListener('offline', offline);
    document.addEventListener('visibilitychange', visible);
    globalThis.addEventListener('unhandledrejection', unhandled);
    globalThis.addEventListener('error', error);
    this.unsubscribers.push(() => {
      globalThis.removeEventListener('online', online);
      globalThis.removeEventListener('offline', offline);
      document.removeEventListener('visibilitychange', visible);
      globalThis.removeEventListener('unhandledrejection', unhandled);
      globalThis.removeEventListener('error', error);
    });
  }

  private subscribe(): void {
    const { stores } = this.services;
    // Remote drafts: 15 s stale drop, the 2 s committed-ghost cap and the 30 s ended-id memory (SPEC section 7.6 receivers).
    let sweep: ReturnType<Scheduler['setTimeout']> | null = null;
    const sweepLoop = (): void => {
      stores.remoteDrafts.getState().update((state) => sweepRemoteDrafts(state, this.scheduler.now()));
      sweep = this.scheduler.setTimeout(sweepLoop, REMOTE_DRAFT_SWEEP_MS);
    };
    sweep = this.scheduler.setTimeout(sweepLoop, REMOTE_DRAFT_SWEEP_MS);
    this.unsubscribers.push(() => {
      this.scheduler.clearTimeout(sweep);
    });
    // Local safety net: the in-progress drawing or edit, debounced (SPEC section 8.6, UX F-02 step 6).
    const autosave = createDebounce<null>(
      () => {
        this.autosave();
      },
      300,
      this.scheduler,
    );
    this.unsubscribers.push(
      stores.drawing.subscribe((state, previous) => {
        if (state.drawing.points !== previous.drawing.points || state.naming !== previous.naming)
          autosave.push(null);
      }),
      stores.edit.subscribe((state, previous) => {
        if (state.edit?.points !== previous.edit?.points) autosave.push(null);
      }),
      () => {
        autosave.cancel();
      },
    );
    // The session ended (the dialog opens, UX F-11 step 2): the live channel closes and the pill reads Signed out
    // instead of Live; `onSignedInAgain` reconnects.
    this.unsubscribers.push(
      stores.auth.subscribe((state, previous) => {
        if (state.sessionProblem !== null && previous.sessionProblem === null) this.realtime.endSession();
      }),
    );
    // Mode changes: held collaboration toasts flush when I stop working (UX section 6.5); the empty hint only fits some modes.
    this.unsubscribers.push(
      stores.workspace.subscribe((state, previous) => {
        if (state.mode !== previous.mode) {
          this.collab.onModeChange(previous.mode, state.mode);
          this.updateEmptyView();
        }
        if (state.presenceOpen && !previous.presenceOpen) this.collab.resetCounter();
        if (
          state.quietMode !== previous.quietMode ||
          state.singleKeyShortcuts !== previous.singleKeyShortcuts
        ) {
          saveDevicePrefs({ quietMode: state.quietMode, singleKeyShortcuts: state.singleKeyShortcuts });
        }
      }),
    );
    // View preference per user and device (UX F-02 step 2, UX-AC-04, UX-AC-48).
    const saveView = createDebounce<null>(
      () => {
        const view = stores.mapView.getState();
        if (this.userId !== null)
          saveViewPreference(this.userId, {
            center: view.center,
            zoom: view.mercatorZoom,
            choice: view.choice,
          });
      },
      500,
      this.scheduler,
    );
    this.unsubscribers.push(
      stores.mapView.subscribe((state, previous) => {
        if (
          state.center !== previous.center ||
          state.zoom !== previous.zoom ||
          state.choice !== previous.choice
        )
          saveView.push(null);
        if (state.viewport !== previous.viewport) this.updateEmptyView();
      }),
      () => {
        saveView.flush();
      },
    );
    // UX-AC-06: an area saved (or arriving) in an empty view removes the empty hint; a deletion may bring it back.
    // A newer version of the selected area refreshes its History (C-13).
    this.unsubscribers.push(
      stores.areas.subscribe((state, previous) => {
        if (state.revision !== previous.revision) {
          this.updateEmptyView();
          this.area.syncHistory();
        }
      }),
    );
    this.unsubscribers.push(
      stores.connection.subscribe((state, previous) => {
        if (previous.state === 'live' && state.state !== 'live') this.changedWhileAway.clear();
      }),
    );
  }

  private autosave(): void {
    const { stores } = this.services;
    const userId = this.userId;
    if (userId === null) return;
    const mode = stores.workspace.getState().mode;
    const drawing = stores.drawing.getState();
    const edit = stores.edit.getState().edit;
    const now = this.scheduler.now();
    if (
      (mode === 'drawing' || mode === 'naming' || mode === 'saving-new') &&
      drawing.drawing.points.length > 0
    ) {
      saveLocalDraft(
        userId,
        {
          kind: mode === 'drawing' ? 'drawing' : 'naming',
          points: drawing.drawing.points,
          name: drawing.naming.name,
          description: drawing.naming.description,
        },
        now,
      );
      return;
    }
    if (edit !== null && isDirty(edit)) {
      saveLocalDraft(
        userId,
        {
          kind: 'edit',
          points: edit.points,
          edit: { areaId: edit.areaId, name: edit.name, baseVersion: edit.baseVersion },
        },
        now,
      );
    }
  }

  // -- committed changes (WS events and feed items) ------------------------------------------

  private onAreaChanged(data: AreaChangedData): void {
    const now = this.scheduler.now();
    const applied: { outcome: ChangeOutcome } = { outcome: 'dropped' };
    this.services.stores.areas.getState().update((state) => {
      const result = applyChange(state, { op: data.op, area: data.area }, now);
      applied.outcome = result.outcome;
      return result.state;
    });
    if (applied.outcome === 'dropped' || applied.outcome === 'stale') return;
    const actor = data.actor;
    this.collab.onChange(
      {
        op: data.op,
        area: data.area,
        changedFields: data.changedFields,
        previousName: data.previousName,
        actor,
      },
      'ws',
    );
    this.reactToChange(data.op, data.area, actor);
  }

  private onFeedChange(change: ChangeLike & { changeSeq: number }, outcome: ChangeOutcome): void {
    if (outcome !== 'upserted' && outcome !== 'deleted') return;
    const actor =
      change.op === 'delete' ? (change.area.deletedBy ?? change.area.updatedBy) : change.area.updatedBy;
    const changedFields: ChangedField[] = change.op === 'delete' ? ['deleted'] : [];
    this.collab.onChange(
      { op: change.op, area: change.area, changedFields, previousName: null, actor },
      'feed',
    );
    const viewport = this.services.stores.mapView.getState().viewport;
    const me = this.services.stores.auth.getState().user;
    if (viewport !== null && bboxesIntersect(viewport, change.area.bbox) && actor.id !== me?.id)
      this.changedWhileAway.add(change.area.id);
    this.reactToChange(change.op, change.area, actor);
  }

  /**
   * Selected / edited area changed or deleted by someone else, or by me in another tab or on another device (UX C-14,
   * C-20, F-09 step 1). Only the echo of this tab's own write is ignored.
   */
  private reactToChange(op: ChangeLike['op'], area: ChangeLike['area'], actor: UserRef | null): void {
    const { stores } = this.services;
    const me = stores.auth.getState().user;
    if (actor !== null && actor.id === me?.id && this.ownWrites.isEcho(area)) return;
    const workspace = stores.workspace.getState();
    const editing = stores.edit.getState().edit;
    const deleted = op === 'delete' || area.deletedAt !== null;
    if (editing?.areaId === area.id) {
      if (deleted) this.conflict.openDeletedWhileEditing(area);
      else this.edit.onRemoteVersion(area, actor);
      return;
    }
    if (workspace.selectedAreaId !== area.id) return;
    if (deleted) {
      stores.workspace.getState().patch({ detail: { areaId: area.id, status: 'deleted', area } });
      return;
    }
    if (workspace.detailsEdit === null && workspace.preview === null) {
      stores.workspace.getState().patch({ detail: { areaId: area.id, status: 'ready', area } });
    }
    // F-09 step 1 for rename / description: the panel shows the warning; say it once, as the shape editor does.
    if (workspace.detailsEdit?.areaId === area.id && area.version > workspace.detailsEdit.baseVersion) {
      const user = displayUser(actor?.displayName ?? base.collab.someone);
      announce(this.ctx, 'status', base.edit.newerVersion(user, area.version));
    }
  }

  private backOnlineToast(): void {
    const count = this.changedWhileAway.size;
    this.changedWhileAway.clear();
    showToast(this.ctx, {
      lane: 'own',
      kind: 'info',
      code: count > 0 ? 'toast.backOnline' : 'toast.backOnlineNoChanges',
      text: count > 0 ? base.toast.backOnline(count) : base.toast.backOnlineNoChanges,
      durationMs: 5000,
    });
  }

  private onSharingStatus(status: SharingStatus): void {
    const drawing = this.services.stores.drawing.getState();
    const previous = drawing.sharing;
    drawing.patch({ sharing: status });
    if (status.kind === 'rate-limited' && previous.kind !== 'rate-limited') {
      announce(this.ctx, 'status', base.rate.sharingPausedSr(wait(status.retryAt - this.scheduler.now())));
      this.services.clock.store.getState().tick();
    }
  }

  /**
   * The empty-view hint (UX C-17, UX-AC-06): no loaded area intersects the view, and the mode offers it. Re-evaluated
   * when a load ends, the view moves, the areas change or the mode changes. The scan stops at the first area in view,
   * and even a full pass over the store (<= 30,000 bbox tests) is cheap next to rendering the same change.
   */
  private updateEmptyView(): void {
    const { stores } = this.services;
    const notices = stores.notices.getState();
    if (notices.load.loading) return;
    const empty =
      offersEmptyHint(stores.workspace.getState().mode) &&
      !hasAreaInView(stores.areas.getState().byId.values(), stores.mapView.getState().viewport);
    if (empty !== notices.emptyView) notices.patch({ emptyView: empty });
  }

  // -- base map (UX section 7) ----------------------------------------------------------------------

  /** The layer *Aerial* shows in this build (SPEC section 8.3). */
  aerialLayer(): BaseLayerId {
    return resolveBaseLayer('aerial', this.env.itmLayerEnabled);
  }

  selectLayer(choice: LayerChoice): void {
    const baseLayer = resolveBaseLayer(choice, this.env.itmLayerEnabled);
    const view = this.services.stores.mapView.getState();
    if (view.choice === choice && view.baseLayer === baseLayer) return;
    view.setChoice(choice, baseLayer);
    announce(this.ctx, 'status', choice === 'map' ? base.layer.switchedMap : base.layer.switchedAerial);
  }

  toggleLayer(): void {
    this.selectLayer(toggledChoice(this.services.stores.mapView.getState().choice));
  }

  // -- restore banner (UX C-24) --------------------------------------------------------------

  restoreLocalDraft(): void {
    const { stores } = this.services;
    const draft = stores.workspace.getState().localDraft;
    stores.workspace.getState().patch({ localDraft: null });
    stores.notices.getState().patch({ restoreDraft: false });
    if (draft === null) return;
    this.resumeDraft(draft);
  }

  private resumeDraft(draft: LocalDraft): void {
    if (draft.kind === 'edit' && draft.edit !== null) {
      const { areaId, baseVersion } = draft.edit;
      const points = draft.points;
      void this.services.api.areas
        .get(areaId)
        .then((area) => {
          this.area.showSaved(area, false);
          this.edit.begin({ ...area, version: baseVersion }, points, null);
          if (area.version > baseVersion) this.edit.onRemoteVersion(area, area.updatedBy);
        })
        .catch(() => {
          showToast(this.ctx, {
            lane: 'own',
            kind: 'info',
            code: 'toast.areaGone',
            text: base.toast.areaGone,
            durationMs: 5000,
          });
        });
      return;
    }
    this.drawing.restore({
      kind: draft.kind === 'naming' ? 'naming' : 'drawing',
      points: draft.points,
      name: draft.name,
      description: draft.description,
    });
  }

  discardLocalDraft(): void {
    const { stores } = this.services;
    const draft = stores.workspace.getState().localDraft;
    const user = stores.auth.getState().user;
    stores.workspace.getState().patch({ localDraft: null });
    stores.notices.getState().patch({ restoreDraft: false });
    if (draft === null || user === null) return;
    markLocalDraftDiscarded(user.id, this.scheduler.now());
    showToast(this.ctx, {
      lane: 'own',
      kind: 'undo',
      code: 'toast.drawingDiscarded',
      text: base.toast.drawingDiscarded,
      durationMs: TOAST_UNDO_MS,
      action: {
        kind: 'undo',
        label: base.toast.undo,
        run: () => {
          saveLocalDraft(user.id, draft, this.scheduler.now());
          stores.workspace.getState().patch({ localDraft: draft });
          stores.notices.getState().patch({ restoreDraft: true });
        },
      },
    });
  }

  // -- keyboard (UX section 8.1) --------------------------------------------------------------------

  hasUnsavedWork(): boolean {
    const { stores } = this.services;
    const mode = stores.workspace.getState().mode;
    const edit = stores.edit.getState().edit;
    return (
      ((mode === 'drawing' || mode === 'naming' || mode === 'saving-new') &&
        stores.drawing.getState().drawing.points.length > 0) ||
      (edit !== null && isDirty(edit))
    );
  }

  /** The document-level key handler (single-key and modifier shortcuts). Returns true when it handled the key. */
  handleGlobalKey(event: KeyInput & { target: EventTarget | null }): boolean {
    const { stores } = this.services;
    const workspace = stores.workspace.getState();
    const command = resolveGlobalKey(event, {
      mode: workspace.mode,
      typing: isTypingTarget(event.target),
      modal: modalOpen(workspace) || stores.auth.getState().sessionProblem !== null,
      singleKeys: workspace.singleKeyShortcuts,
      mapFocused: false,
      popoverOpen: workspace.userMenuOpen || workspace.presenceOpen || workspace.connectionPopoverOpen,
      panelOpen: workspace.panel !== 'none',
      detailsEditing: workspace.detailsEdit !== null,
    });
    if (command === null) return false;
    return this.runCommand(command);
  }

  runCommand(command: GlobalCommand): boolean {
    const { stores } = this.services;
    const workspace = stores.workspace.getState();
    switch (command) {
      case 'draw':
        this.drawing.start('keyboard');
        return true;
      case 'toggle-layer':
        this.toggleLayer();
        return true;
      case 'areas':
        this.area.toggleList(true);
        return true;
      case 'presence':
        this.showPeople(true);
        return true;
      case 'shortcuts':
        workspace.patch({ shortcutsOpen: true });
        return true;
      case 'edit':
        this.edit.start('key');
        return true;
      case 'history':
        this.area.showHistory(true);
        return true;
      case 'zoom-to-area':
        this.area.zoomTo();
        return true;
      case 'rename':
        this.area.startDetailsEdit('name');
        return true;
      case 'delete':
        this.area.deleteSelected();
        return true;
      case 'escape':
        return this.escape();
      case 'undo':
        return this.undo();
      case 'save':
        if (workspace.mode === 'naming') this.drawing.save(true);
        else if (workspace.mode === 'editing-shape') this.edit.save(true);
        return true;
    }
  }

  // -- inspector (UX C-28, section 6.1) --------------------------------------------------------------

  /**
   * `P`, the rail's *People* and `presence-button`: phones toggle the presence popover (v1.2); wider layouts expand
   * the People section and scroll it into view (the overlay opens for it), and by keyboard move focus to its header.
   * Never a toggle there: only the section header collapses People. Either way this is an explicit request to see
   * who is here, so it clears the busy-area counter (section 6.1).
   */
  showPeople(viaKeyboard: boolean): void {
    const workspace = this.services.stores.workspace.getState();
    if (workspace.layout === 'phone') {
      workspace.patch({
        presenceOpen: !workspace.presenceOpen,
        userMenuOpen: false,
        connectionPopoverOpen: false,
      });
      return;
    }
    workspace.patch({
      peopleExpanded: true,
      inspectorExtras: workspace.layout === 'overlay' ? true : workspace.inspectorExtras,
      userMenuOpen: false,
      connectionPopoverOpen: false,
    });
    this.collab.resetCounter();
    workspace.requestReveal('people');
    if (viaKeyboard) workspace.requestFocus('people-header');
  }

  /** A section header's disclosure button (People / Activity). Expanding People also clears the busy counter. */
  toggleSection(section: 'people' | 'activity'): void {
    const workspace = this.services.stores.workspace.getState();
    const expanded = !sectionExpanded(workspace, section);
    workspace.patch(section === 'people' ? { peopleExpanded: expanded } : { activityExpanded: expanded });
    if (section === 'people' && expanded) this.collab.resetCounter();
  }

  /** `inspector-close`: hides an overlay that holds only People / Activity (UX C-28). */
  closeInspectorExtras(): void {
    this.services.stores.workspace.getState().patch({ inspectorExtras: false });
  }

  /** `Esc` closes the topmost layer, one per press (UX section 8.1). */
  escape(): boolean {
    const { stores } = this.services;
    const workspace = stores.workspace.getState();
    if (workspace.userMenuOpen || workspace.presenceOpen || workspace.connectionPopoverOpen) {
      workspace.patch({ userMenuOpen: false, presenceOpen: false, connectionPopoverOpen: false });
      return true;
    }
    switch (workspace.mode) {
      case 'previewing-version':
        this.area.exitPreview();
        return true;
      case 'resolving-conflict':
        this.conflict.decideLater();
        return true;
      case 'editing-shape':
        this.edit.escape();
        return true;
      case 'drawing':
        this.drawing.cancel();
        return true;
      case 'naming':
        this.drawing.backToDrawing();
        return true;
      case 'area-selected':
        if (workspace.detailsEdit !== null) this.area.cancelDetailsEdit();
        else this.area.close();
        return true;
      case 'browse':
        if (workspace.panel === 'list') {
          workspace.patch({ panel: 'none' });
          return true;
        }
        // The overlay inspector showing only People / Activity is the next layer (UX section 8.1, C-28).
        if (workspace.layout === 'overlay' && workspace.inspectorExtras) {
          this.closeInspectorExtras();
          return true;
        }
        return false;
      case 'saving-new':
      case 'saving-edit':
        return false;
    }
  }

  /** `Ctrl/Cmd+Z`: points while drawing/editing, otherwise the newest visible Undo toast (UX section 8.1, C-18). */
  undo(): boolean {
    const { stores } = this.services;
    const mode: Mode = stores.workspace.getState().mode;
    if (mode === 'drawing') {
      this.drawing.undo();
      return true;
    }
    if (mode === 'editing-shape') {
      this.edit.undo();
      return true;
    }
    const toasts = stores.toasts.getState().toasts;
    const undoable = [...toasts].reverse().find((toast) => toast.action?.kind === 'undo');
    if (undoable?.action !== undefined) {
      stores.toasts.getState().dismiss(undoable.id);
      undoable.action.run(true);
      return true;
    }
    const lastUndo = stores.toasts.getState().lastUndo;
    if (lastUndo !== null && lastUndo.expiresAt > this.scheduler.now()) {
      stores.toasts.getState().clearLastUndo();
      lastUndo.run(true);
      return true;
    }
    return false;
  }

  /** Keys of the focused map container (UX section 8.1 "Map focused", "Drawing", "Editing shape"). */
  handleMapKey(event: KeyInput): MapCommand | null {
    const { stores } = this.services;
    const workspace = stores.workspace.getState();
    if (modalOpen(workspace)) return null;
    return resolveMapKey(event, {
      mode: workspace.mode,
      pointSelected: stores.edit.getState().edit?.selected !== null && stores.edit.getState().edit !== null,
      panPx: KEY_PAN_PX,
      finePanPx: KEY_PAN_FINE_PX,
      movePx: KEY_MOVE_POINT_PX,
      fineMovePx: KEY_MOVE_POINT_FINE_PX,
    });
  }

  // -- sign out (UX F-14, C-22) --------------------------------------------------------------

  requestSignOut(): void {
    if (this.hasUnsavedWork()) {
      this.services.stores.workspace.getState().patch({ signOutConfirmOpen: true, userMenuOpen: false });
      return;
    }
    void this.signOut(false);
  }

  async signOut(discard: boolean): Promise<void> {
    const { stores } = this.services;
    const user = stores.auth.getState().user;
    if (discard && user !== null) markLocalDraftDiscarded(user.id, this.scheduler.now());
    this.draft.close('cancelled');
    this.realtime.stop();
    stores.workspace.getState().patch({ signOutConfirmOpen: false, userMenuOpen: false });
    await this.services.signOut();
    navigate('/signin?signedout=1', { replace: true });
  }

  retryConnectionNow(): void {
    this.realtime.retryNow();
  }
}
