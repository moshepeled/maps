/**
 * My own live draft (SPEC section 7.6, section 7.12 steps 3, 9, 10, 11; UX F-03 step 2, F-12 step 2): starting, streaming,
 * keeping it alive, and recovering it - all invisible to the user, who keeps drawing locally whatever happens.
 *
 * - `draft.start` on the first point; `draft.update` <= 10 Hz (trailing throttle, final state always sent, 6 dp);
 * - `draft.touch` whenever `draftTouchIntervalMs` passes without an update while the draft is open (incl. Naming);
 * - RATE_LIMITED start -> updates held, the start is re-sent with the same id after the countdown;
 * - own `draft.ended expired`, the first DRAFT_NOT_FOUND on an update/touch, a refused resume, or DRAFT_ID_IN_USE ->
 *   a NEW draft id with every point kept, a non-resume start, then the latest state. At most one automatic re-start
 *   per 60 s; a second failure pauses sharing (chip without countdown) until the next point change;
 * - the save uses the current id, so the committed area replaces the ghost; AREA_ID_CONFLICT -> new id, one retry,
 *   then `draft.end cancelled` for the old id.
 */
import type { AreaMutationResponse, CreateAreaRequest, Position } from '@snapland/shared';
import { DRAFT_DECIMALS, quantizePosition } from '@snapland/shared';

import { DRAFT_RESTART_GUARD_MS, RATE_LIMIT_DEFAULT_WAIT_MS } from '../constants/ux';
import type { Scheduler } from '../lib/scheduler';
import { Timer } from '../lib/scheduler';
import type { Throttled } from '../lib/throttle';
import { createThrottle } from '../lib/throttle';
import type { ErrorData, RealtimeClient, RequestResult } from './RealtimeClient';

export type SharingStatus =
  | { kind: 'idle' }
  | { kind: 'starting' }
  | { kind: 'live' }
  | { kind: 'rate-limited'; retryAt: number }
  | { kind: 'paused' }
  | { kind: 'local' };

export interface DraftSnapshot {
  vertices: readonly Position[];
  cursor: Position | null;
}

export type DraftTransport = Pick<RealtimeClient, 'send' | 'request' | 'isLive'>;

export interface DraftSessionDeps {
  transport: DraftTransport;
  scheduler: Scheduler;
  newId(): string;
  /** From `welcome.limits` / `GET /config` (20 s by default). */
  touchIntervalMs(): number;
  /** From `welcome.limits` / `GET /config` (100 ms by default). */
  updateIntervalMs(): number;
  onStatus(status: SharingStatus): void;
}

type RecoveryReason = 'expired' | 'not-found' | 'resume-refused' | 'in-use';

function toWire(position: Position): Position {
  return quantizePosition(position, DRAFT_DECIMALS);
}

/** Does a ref-less DRAFT_NOT_FOUND talk about `draftId`? Servers name the id in `details` or in the message. */
function mentionsDraft(error: ErrorData, draftId: string): boolean | null {
  const details = error.details;
  if (typeof details === 'object' && details !== null && 'draftId' in details) {
    return details.draftId === draftId;
  }
  const ids = error.message.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/giu);
  if (ids === null) return null;
  return ids.some((id) => id.toLowerCase() === draftId.toLowerCase());
}

export class DraftSession {
  private id: string | null = null;
  private areaId: string | null = null;
  /** The server acknowledged the start: this connection owns the draft (updates and touches are accepted). */
  private claimed = false;
  /** A start was acknowledged at least once, so a reconnect tries a free resume first. */
  private everClaimed = false;
  private rev = 0;
  private latest: DraftSnapshot = { vertices: [], cursor: null };
  private lastRestartAt: number | null = null;
  private status: SharingStatus = { kind: 'idle' };
  private startGeneration = 0;
  private readonly touchTimer: Timer;
  private readonly rateLimitTimer: Timer;
  private readonly updates: Throttled<DraftSnapshot>;

  constructor(private readonly deps: DraftSessionDeps) {
    this.touchTimer = new Timer(deps.scheduler, () => {
      this.sendTouch();
    });
    this.rateLimitTimer = new Timer(deps.scheduler, () => {
      void this.start(false);
    });
    this.updates = createThrottle<DraftSnapshot>(
      (snapshot) => {
        this.sendUpdate(snapshot);
      },
      deps.updateIntervalMs(),
      deps.scheduler,
    );
  }

  /** The id the save must use (`POST /areas {id}`), or null when no draft is open. */
  get draftId(): string | null {
    return this.id;
  }

  get isOpen(): boolean {
    return this.id !== null;
  }

  /** Opens a draft on the first point (new area: `areaId` null) or when an edit starts (`areaId` set). */
  open(areaId: string | null, snapshot: DraftSnapshot): void {
    this.reset();
    this.id = this.deps.newId();
    this.areaId = areaId;
    this.latest = snapshot;
    void this.start(false);
  }

  /**
   * New local state (points or pointer). `pointsChanged` marks a point placed/removed/moved: a paused sharing retries
   * then (UX F-03 step 2).
   */
  update(snapshot: DraftSnapshot, pointsChanged = true): void {
    if (this.id === null) return;
    this.latest = snapshot;
    if (this.status.kind === 'paused' && pointsChanged) {
      this.restart('not-found', true);
      return;
    }
    if (this.claimed) this.updates.push(snapshot);
  }

  /** Ends the draft (`draft.end`), e.g. cancel or after a committed save. */
  close(outcome: 'committed' | 'cancelled', committedAreaId: string | null = null): void {
    const id = this.id;
    if (id === null) return;
    if (this.claimed) {
      this.updates.flush();
      void this.deps.transport.request({
        type: 'draft.end',
        data: { draftId: id, outcome, areaId: outcome === 'committed' ? committedAreaId : null },
      });
    }
    this.reset();
  }

  /** The socket closed: this connection no longer owns the draft; keep drawing locally until `welcome`. */
  handleDisconnected(): void {
    if (this.id === null) return;
    this.claimed = false;
    this.updates.cancel();
    this.touchTimer.cancel();
    if (this.status.kind !== 'rate-limited') this.setStatus({ kind: 'local' });
  }

  /** After `welcome` (SPEC section 7.12 step 3): a free resume if the draft had been started, else a normal start. */
  handleWelcome(): void {
    if (this.id === null || this.rateLimitTimer.pending) return;
    void this.start(this.everClaimed);
  }

  /** A `draft.ended` addressed to my own draft (the owner always receives it, SPEC section 7.6). */
  handleOwnDraftEnded(draftId: string, outcome: string): void {
    if (draftId !== this.id || outcome !== 'expired') return;
    this.restart('expired');
  }

  /** A ref-less `error` from the server: DRAFT_NOT_FOUND answers an update or touch of the current draft. */
  handleServerError(error: ErrorData): void {
    if (error.code !== 'DRAFT_NOT_FOUND' || this.id === null || !this.claimed) return;
    if (mentionsDraft(error, this.id) === false) return;
    this.restart('not-found');
  }

  /** Sends `draft.end cancelled` for an id that is no longer the save's id, then forgets the session. */
  endReplaced(oldId: string): void {
    if (this.claimed && oldId === this.id) {
      this.updates.cancel();
      void this.deps.transport.request({
        type: 'draft.end',
        data: { draftId: oldId, outcome: 'cancelled', areaId: null },
      });
    }
    this.reset();
  }

  dispose(): void {
    this.reset();
  }

  // -- internals -----------------------------------------------------------------------------

  private async start(resume: boolean): Promise<void> {
    const id = this.id;
    if (id === null) return;
    this.rateLimitTimer.cancel();
    this.startGeneration += 1;
    const generation = this.startGeneration;
    if (!this.deps.transport.isLive) {
      this.setStatus({ kind: 'local' });
      return;
    }
    this.setStatus({ kind: 'starting' });
    const result: RequestResult = await this.deps.transport.request({
      type: 'draft.start',
      data: { draftId: id, areaId: this.areaId, resume },
    });
    // A newer start, a close or a new id superseded this one while it was in flight.
    if (generation !== this.startGeneration || id !== this.id) return;
    if (result.ok) {
      this.claimed = true;
      this.everClaimed = true;
      this.setStatus({ kind: 'live' });
      // Through the throttle, so the next pointer move respects the 10 Hz budget from this send on.
      this.updates.push(this.latest);
      this.updates.flush();
      return;
    }
    this.handleStartError(result.error, resume);
  }

  private handleStartError(
    error: { code: string; retryAfterMs?: number | undefined },
    resume: boolean,
  ): void {
    switch (error.code) {
      case 'RATE_LIMITED': {
        const wait = error.retryAfterMs ?? RATE_LIMIT_DEFAULT_WAIT_MS;
        this.setStatus({ kind: 'rate-limited', retryAt: this.deps.scheduler.now() + wait });
        this.rateLimitTimer.arm(wait);
        return;
      }
      case 'DRAFT_NOT_FOUND':
        this.restart(resume ? 'resume-refused' : 'not-found');
        return;
      case 'DRAFT_ID_IN_USE':
        this.restart('in-use');
        return;
      case 'NOT_CONNECTED':
      case 'TIMEOUT':
        this.setStatus({ kind: 'local' });
        return;
      default:
        this.setStatus({ kind: 'paused' });
    }
  }

  /** New id, points kept, non-resume start - at most once per DRAFT_RESTART_GUARD_MS unless `force`d. */
  private restart(_reason: RecoveryReason, force = false): void {
    const now = this.deps.scheduler.now();
    if (!force && this.lastRestartAt !== null && now - this.lastRestartAt < DRAFT_RESTART_GUARD_MS) {
      this.claimed = false;
      this.updates.cancel();
      this.touchTimer.cancel();
      this.setStatus({ kind: 'paused' });
      return;
    }
    this.lastRestartAt = now;
    this.id = this.deps.newId();
    this.claimed = false;
    this.everClaimed = false;
    this.rev = 0;
    this.updates.cancel();
    this.touchTimer.cancel();
    void this.start(false);
  }

  private sendUpdate(snapshot: DraftSnapshot): void {
    const id = this.id;
    if (id === null || !this.claimed) return;
    this.rev += 1;
    this.deps.transport.send({
      type: 'draft.update',
      data: {
        draftId: id,
        rev: this.rev,
        vertices: snapshot.vertices.map(toWire),
        cursor: snapshot.cursor === null ? null : toWire(snapshot.cursor),
      },
    });
    this.touchTimer.arm(this.deps.touchIntervalMs());
  }

  private sendTouch(): void {
    const id = this.id;
    if (id === null || !this.claimed) return;
    this.deps.transport.send({ type: 'draft.touch', data: { draftId: id } });
    this.touchTimer.arm(this.deps.touchIntervalMs());
  }

  private reset(): void {
    this.id = null;
    this.areaId = null;
    this.claimed = false;
    this.everClaimed = false;
    this.rev = 0;
    this.lastRestartAt = null;
    this.startGeneration += 1;
    this.latest = { vertices: [], cursor: null };
    this.updates.cancel();
    this.touchTimer.cancel();
    this.rateLimitTimer.cancel();
    this.setStatus({ kind: 'idle' });
  }

  private setStatus(status: SharingStatus): void {
    this.status = status;
    this.deps.onStatus(status);
  }
}

/** The `code` of an API error, for the id-conflict rule (kept structural so the session does not import the API). */
export interface CodedError {
  code: string;
}

function isIdConflict(error: unknown): boolean {
  return (
    typeof error === 'object' && error !== null && (error as Partial<CodedError>).code === 'AREA_ID_CONFLICT'
  );
}

/**
 * Creates the area from the open draft (SPEC section 6.3, section 7.12 step 10): `id = draftId`; on AREA_ID_CONFLICT a fresh id and
 * exactly one retry, then `draft.end cancelled` for the old id; a second conflict surfaces to the caller.
 */
export async function saveDraftAsArea(
  session: DraftSession,
  body: Omit<CreateAreaRequest, 'id'>,
  createArea: (request: CreateAreaRequest) => Promise<AreaMutationResponse>,
  newId: () => string,
): Promise<AreaMutationResponse> {
  const id = session.draftId ?? newId();
  try {
    const response = await createArea({ ...body, id });
    session.close('committed', response.area.id);
    return response;
  } catch (error) {
    if (!isIdConflict(error)) throw error;
  }
  // The fresh id is only the area's id: it is not started as a draft (the old draft is ended below).
  const oldId = session.draftId;
  const response = await createArea({ ...body, id: newId() });
  if (oldId !== null) session.endReplaced(oldId);
  else session.dispose();
  return response;
}
