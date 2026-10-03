/**
 * Collaboration awareness without noise (UX section 6.5, section 6.6, C-08): remote changes pulse on the map in the actor's colour
 * (a static ring + chip with reduced motion); toasts are scoped (creates/deletes/restores in view, any change of the
 * area I have selected), batched over 3 s, at most one every 5 s, held while I work (then one summary), throttled by
 * the burst rule (3 toasts a minute -> a silent counter on the presence button), and silenced by Quiet mode. The
 * `collab` live region gets at most one announcement per 30 s.
 */
import type { AreaDto, AreaOp, Bbox, ChangedField, UserRef } from '@snapland/shared';
import { bboxesIntersect } from '@snapland/shared';

import {
  COLLAB_BATCH_WINDOW_MS,
  COLLAB_BURST_LIMIT,
  COLLAB_BURST_WINDOW_MS,
  COLLAB_COUNTER_RESET_MS,
  COLLAB_SR_MIN_GAP_MS,
  COLLAB_TOAST_MIN_GAP_MS,
  PULSE_MS,
  PULSE_STATIC_MS,
  TOAST_INFO_MS,
} from '../constants/ux';
import { base, joinUsers } from '../base/en';
import { formatArea } from '../lib/format';
import type { TimerHandle } from '../lib/scheduler';
import type { ActivityCode } from '../state/activityStore';
import { displayName, displayUser } from '../lib/text';
import type { Mode } from '../state/workspaceStore';
import { isWorkingMode } from '../state/workspaceStore';
import type { WorkspaceContext } from './context';
import { currentUser } from './context';

export interface CollabEvent {
  op: AreaOp;
  area: AreaDto;
  changedFields: readonly ChangedField[];
  previousName: string | null;
  actor: UserRef | null;
}

const LAST_ACTORS_MAX = 500;

/** Which single-event message an event gets: its copy key (UX section 9.8; `activity-item[data-code]`, C-31). */
export function collabCode(event: CollabEvent): Exclude<ActivityCode, 'collab.restoredVersion'> {
  switch (event.op) {
    case 'create':
      return 'collab.created';
    case 'delete':
      return 'collab.deleted';
    case 'restore':
      return 'collab.undeleted';
    case 'update': {
      const fields = event.changedFields.filter((field) => field !== 'deleted');
      if (fields.length === 1 && fields[0] === 'geometry') return 'collab.reshaped';
      if (fields.length === 1 && fields[0] === 'name') return 'collab.renamed';
      if (fields.length === 1 && fields[0] === 'description') return 'collab.described';
      return 'collab.updated';
    }
  }
}

/** The specific one-event copy (UX section 9.8). */
export function collabMessage(event: CollabEvent): string {
  const user = displayUser(event.actor?.displayName ?? base.collab.someone);
  const name = displayName(event.area.name);
  const code = collabCode(event);
  switch (code) {
    case 'collab.created':
      return base.collab.created(user, name, formatArea(event.area.areaKm2));
    case 'collab.deleted':
      return base.collab.deleted(user, name);
    case 'collab.undeleted':
      return base.collab.undeleted(user, name);
    case 'collab.reshaped':
      return base.collab.reshaped(user, name, formatArea(event.area.areaKm2));
    case 'collab.renamed':
      return base.collab.renamed(user, displayName(event.previousName ?? event.area.name), name);
    case 'collab.described':
      return base.collab.described(user, name);
    case 'collab.updated':
      return base.collab.updated(user, name);
  }
}

export class CollabNotifier {
  private batch: CollabEvent[] = [];
  private held: CollabEvent[] = [];
  private batchTimer: TimerHandle | null = null;
  private counterTimer: TimerHandle | null = null;
  private readonly pulseTimers = new Map<string, TimerHandle>();
  private toastTimes: number[] = [];
  private lastToastAt = Number.NEGATIVE_INFINITY;
  private lastAnnouncementAt = Number.NEGATIVE_INFINITY;
  private counterMode = false;
  private readonly actors = new Map<string, UserRef>();
  /** The single-event collaboration toast I may still be reading, and the area it is about. */
  private shown: { toastId: string; areaId: string } | null = null;

  constructor(
    private readonly ctx: WorkspaceContext,
    private readonly viewport: () => Bbox | null,
  ) {}

  /** The most recent actor seen for an area (auto-merge toasts name them, UX F-09 step 2). */
  lastActor(areaId: string): UserRef | null {
    return this.actors.get(areaId) ?? null;
  }

  private rememberActor(areaId: string, actor: UserRef): void {
    this.actors.delete(areaId);
    this.actors.set(areaId, actor);
    if (this.actors.size > LAST_ACTORS_MAX) {
      const oldest = this.actors.keys().next();
      if (oldest.done !== true) this.actors.delete(oldest.value);
    }
  }

  /** A committed change by someone else: WS events toast; feed items (polling, resync) only pulse. */
  onChange(event: CollabEvent, source: 'ws' | 'feed'): void {
    if (event.actor !== null) this.rememberActor(event.area.id, event.actor);
    const me = currentUser(this.ctx);
    if (event.actor !== null && event.actor.id === me?.id) return;
    this.pulse(event);
    if (source !== 'ws' || !this.inScope(event)) return;
    this.recordActivity(event);
    // A newer event about an area replaces the older one I have not read yet: "Dana deleted it" must not stay on screen
    // (or arrive) after the area is back.
    this.batch = this.batch.filter((queued) => queued.area.id !== event.area.id);
    if (this.shown?.areaId === event.area.id) {
      this.ctx.stores.toasts.getState().dismiss(this.shown.toastId);
      this.shown = null;
    }
    const workspace = this.ctx.stores.workspace.getState();
    if (workspace.quietMode) return;
    // Events on the area I am editing surface in the HUD or the C-20 dialog instead (UX section 6.5).
    const editing = this.ctx.stores.edit.getState().edit;
    if (editing?.areaId === event.area.id) return;
    if (isWorkingMode(workspace.mode)) {
      this.held.push(event);
      return;
    }
    if (this.counterMode) {
      this.bumpCounter(1);
      return;
    }
    this.batch.push(event);
    if (this.batchTimer === null) this.armBatch(COLLAB_BATCH_WINDOW_MS);
  }

  /**
   * The Activity section (UX C-31) lists every in-scope event with an actor, one row each, whatever the toast rules
   * decide: holding, batching, the burst rule and Quiet mode notify; the list notifies nobody.
   */
  private recordActivity(event: CollabEvent): void {
    const actor = event.actor;
    if (actor === null) return;
    this.ctx.stores.activity.getState().record({
      areaId: event.area.id,
      code: collabCode(event),
      actor: { id: actor.id, displayName: actor.displayName, color: actor.color },
      text: collabMessage(event),
      areaKm2: event.op === 'delete' ? null : event.area.areaKm2,
      at: this.ctx.scheduler.now(),
    });
  }

  /** In scope: create / delete / restore of an area in my view, or any change of the area I have selected. */
  private inScope(event: CollabEvent): boolean {
    const selected = this.ctx.stores.workspace.getState().selectedAreaId;
    if (selected === event.area.id) return true;
    if (event.op === 'update') return false;
    const view = this.viewport();
    return view !== null && bboxesIntersect(view, event.area.bbox);
  }

  private pulse(event: CollabEvent): void {
    if (event.op === 'delete') return;
    const view = this.viewport();
    if (view === null || !bboxesIntersect(view, event.area.bbox)) return;
    const reduced = this.ctx.reducedMotion();
    const duration = reduced ? PULSE_STATIC_MS : PULSE_MS;
    const effects = this.ctx.stores.effects.getState();
    effects.addPulse({
      areaId: event.area.id,
      // No actor: the map resolves the neutral saved-area colour of its current tone (UX section 6.2).
      color: event.actor?.color ?? null,
      userId: event.actor?.id ?? null,
      userName: event.actor?.displayName ?? null,
      until: this.ctx.scheduler.now() + duration,
      staticRing: reduced,
    });
    this.ctx.scheduler.clearTimeout(this.pulseTimers.get(event.area.id));
    this.pulseTimers.set(
      event.area.id,
      this.ctx.scheduler.setTimeout(() => {
        this.pulseTimers.delete(event.area.id);
        this.ctx.stores.effects.getState().removePulse(event.area.id);
      }, duration),
    );
  }

  private armBatch(delayMs: number): void {
    this.ctx.scheduler.clearTimeout(this.batchTimer);
    this.batchTimer = this.ctx.scheduler.setTimeout(() => {
      this.batchTimer = null;
      this.flushBatch();
    }, delayMs);
  }

  private flushBatch(): void {
    if (this.batch.length === 0) return;
    const now = this.ctx.scheduler.now();
    const gap = this.lastToastAt + COLLAB_TOAST_MIN_GAP_MS - now;
    if (gap > 0) {
      this.armBatch(gap);
      return;
    }
    const events = this.batch;
    this.batch = [];
    if (this.counterMode) {
      this.bumpCounter(events.length);
      return;
    }
    const first = events[0];
    if (first === undefined) return;
    const text =
      events.length === 1
        ? collabMessage(first)
        : base.collab.summary(events.length, joinUsers(this.userNames(events)));
    this.emit(text, events, events.length === 1 ? 'collab.single' : 'collab.summary');
  }

  private userNames(events: readonly CollabEvent[]): string[] {
    return events.map((event) => displayUser(event.actor?.displayName ?? base.collab.someone));
  }

  private emit(text: string, events: readonly CollabEvent[], code: string): void {
    const now = this.ctx.scheduler.now();
    const first = events[0];
    const toastId = this.ctx.stores.toasts.getState().push(
      {
        lane: 'collab',
        kind: 'collab',
        code,
        text,
        durationMs: TOAST_INFO_MS,
        actor:
          first?.actor === null || first === undefined
            ? undefined
            : { displayName: first.actor.displayName, color: first.actor.color },
      },
      now,
    );
    this.shown = events.length === 1 && first !== undefined ? { toastId, areaId: first.area.id } : null;
    this.lastToastAt = now;
    if (now - this.lastAnnouncementAt >= COLLAB_SR_MIN_GAP_MS) {
      this.lastAnnouncementAt = now;
      this.ctx.stores.live.getState().announce('collab', text);
    }
    this.toastTimes = [...this.toastTimes.filter((at) => now - at < COLLAB_BURST_WINDOW_MS), now];
    if (this.toastTimes.length >= COLLAB_BURST_LIMIT) {
      this.counterMode = true;
      this.armCounterReset();
    }
  }

  private bumpCounter(count: number): void {
    const presence = this.ctx.stores.presence.getState();
    presence.setChangesCounter(presence.changesCounter + count);
    this.armCounterReset();
  }

  /** Toasts resume, and the counter clears, after 2 min without collaboration events (UX section 6.5 burst rule). */
  private armCounterReset(): void {
    this.ctx.scheduler.clearTimeout(this.counterTimer);
    this.counterTimer = this.ctx.scheduler.setTimeout(() => {
      this.counterTimer = null;
      this.resetCounter();
    }, COLLAB_COUNTER_RESET_MS);
  }

  /** Opening the presence list also ends counter mode. */
  resetCounter(): void {
    this.counterMode = false;
    this.toastTimes = [];
    this.ctx.stores.presence.getState().setChangesCounter(0);
  }

  /** Leaving Drawing / Naming / EditingShape flushes the held events as ONE summary (UX section 6.5 "Held while I work"). */
  onModeChange(previous: Mode, next: Mode): void {
    if (!isWorkingMode(previous) || isWorkingMode(next) || this.held.length === 0) return;
    const held = this.held.filter((event) => this.inScope(event));
    this.held = [];
    if (held.length === 0 || this.ctx.stores.workspace.getState().quietMode) return;
    if (this.counterMode) {
      this.bumpCounter(held.length);
      return;
    }
    const first = held[0];
    if (first === undefined) return;
    const text =
      held.length === 1
        ? base.collab.heldSummary(1, displayUser(first.actor?.displayName ?? base.collab.someone))
        : base.collab.heldSummary(held.length, joinUsers(this.userNames(held)));
    this.emit(
      held.length === 1 ? `While you worked: ${collabMessage(first)}` : text,
      held,
      'collab.heldSummary',
    );
  }

  dispose(): void {
    this.ctx.scheduler.clearTimeout(this.batchTimer);
    this.ctx.scheduler.clearTimeout(this.counterTimer);
    for (const handle of this.pulseTimers.values()) this.ctx.scheduler.clearTimeout(handle);
    this.pulseTimers.clear();
  }
}
