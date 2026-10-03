/**
 * Advisory soft locks I hold (SPEC section 7.9, UX F-10): `lock.acquire` when an edit or rename starts, renewed every
 * LOCK_HEARTBEAT_MS while it lasts, `lock.release` when it ends. The lock never blocks anyone; its outcome only
 * drives the HUD copy (mine / someone else holds it / unknown).
 */
import type { ErrorData } from '../realtime/RealtimeClient';
import { LOCK_HEARTBEAT_MS } from '../constants/ux';
import type { TimerHandle } from '../lib/scheduler';
import type { WorkspaceContext } from './context';

export type LockScope = 'geometry' | 'details';

export type LockOutcome =
  | { kind: 'acquired' }
  | { kind: 'held'; holder: { displayName: string; color: string } | null }
  | { kind: 'unknown' }
  | { kind: 'limit' };

interface HeldLock {
  scope: LockScope;
  timer: TimerHandle | null;
  generation: number;
}

function holderOf(error: ErrorData): { displayName: string; color: string } | null {
  const details = error.details;
  if (typeof details !== 'object' || details === null || !('holder' in details)) return null;
  const holder = details.holder;
  if (typeof holder !== 'object' || holder === null) return null;
  const { displayName, color } = holder as { displayName?: unknown; color?: unknown };
  return typeof displayName === 'string' && typeof color === 'string' ? { displayName, color } : null;
}

export function outcomeOf(result: Awaited<ReturnType<WorkspaceContext['realtime']['request']>>): LockOutcome {
  if (result.ok) return { kind: 'acquired' };
  switch (result.error.code) {
    case 'LOCK_HELD':
      return { kind: 'held', holder: holderOf(result.error) };
    case 'LOCK_LIMIT_REACHED':
      return { kind: 'limit' };
    default:
      // LOCK_UNAVAILABLE (Redis down), THROTTLED, NOT_CONNECTED, TIMEOUT: the lock state is unknown (UX F-10 step 10).
      return { kind: 'unknown' };
  }
}

export class LockKeeper {
  private readonly held = new Map<string, HeldLock>();
  private generation = 0;

  constructor(private readonly ctx: WorkspaceContext) {}

  /** Acquires (or renews) a lock and keeps renewing it until `release`. */
  async acquire(areaId: string, scope: LockScope): Promise<LockOutcome> {
    this.release(areaId);
    this.generation += 1;
    const entry: HeldLock = { scope, timer: null, generation: this.generation };
    this.held.set(areaId, entry);
    const outcome = await this.request(areaId, scope);
    if (this.held.get(areaId) !== entry) return outcome;
    this.scheduleRenewal(areaId, entry);
    return outcome;
  }

  release(areaId: string): void {
    const entry = this.held.get(areaId);
    if (entry === undefined) return;
    this.ctx.scheduler.clearTimeout(entry.timer);
    this.held.delete(areaId);
    this.ctx.realtime.send({ type: 'lock.release', data: { areaId } });
  }

  releaseAll(): void {
    for (const areaId of [...this.held.keys()]) this.release(areaId);
  }

  /** After a reconnect every lock of this connection is gone server-side: take them again. */
  reacquireAll(): void {
    for (const [areaId, entry] of this.held) void this.request(areaId, entry.scope);
  }

  private request(areaId: string, scope: LockScope): Promise<LockOutcome> {
    return this.ctx.realtime.request({ type: 'lock.acquire', data: { areaId, scope } }).then(outcomeOf);
  }

  private scheduleRenewal(areaId: string, entry: HeldLock): void {
    entry.timer = this.ctx.scheduler.setTimeout(() => {
      if (this.held.get(areaId) !== entry) return;
      // Renewals are free; a LOCK_LIMIT_REACHED renewal retries at the next tick (UX F-10 step 10).
      void this.request(areaId, entry.scope).then(() => {
        if (this.held.get(areaId) === entry) this.scheduleRenewal(areaId, entry);
      });
    }, LOCK_HEARTBEAT_MS);
  }
}
