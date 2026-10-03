/**
 * Advisory edit soft locks (SPEC section 7.9). A connection holds at most WS_MAX_LOCKS_PER_CONNECTION locks: a NEW acquire
 * beyond the cap is refused with LOCK_LIMIT_REACHED before any Redis call, while renewals (re-sending `lock.acquire`
 * for a held area, every 10 s) are free and uncounted. The first acquire reads the area bbox through
 * `container.areasReader` (no SQL here) and the holder profile from the ticket claims. Redis down -> LOCK_UNAVAILABLE
 * (editing stays allowed: locks are advisory, REST never checks them). Denials are audited through the coalescer.
 */
import type { Bbox, ClientMessageOf, ServerMessageOf } from '@snapland/shared';

import type { AppConfig } from '../../config/env.js';
import type { Clock } from '../../infra/clock.js';
import type { AreaReader } from '../../infra/directory/types.js';
import type { EventBus } from '../../infra/events/types.js';
import type { Logger } from '../../infra/logger.js';
import type { Connection } from './connection.js';
import type { LockRecord, LockStore } from './lock-store.js';
import { ackMessage, criticalMessage, errorMessage } from './messages.js';
import { PROTOCOL_LIMITS } from './protocol-limits.js';
import type { RealtimeAudit } from './realtime-audit.js';
import type { HeldLock } from './types.js';

type LockAcquireData = ClientMessageOf<'lock.acquire'>['data'];
type LockReleaseData = ClientMessageOf<'lock.release'>['data'];
export type LockSnapshotItem = ServerMessageOf<'lock.snapshot'>['data']['items'][number];
type LockDenialCode = 'LOCK_HELD' | 'LOCK_UNAVAILABLE' | 'LOCK_LIMIT_REACHED' | 'AREA_NOT_FOUND';

export interface LockServiceDeps {
  store: LockStore;
  areasReader: AreaReader;
  events: EventBus;
  clock: Clock;
  logger: Logger;
  config: Pick<AppConfig, 'WS_MAX_LOCKS_PER_CONNECTION' | 'REALTIME_LOCK_TTL_MS'>;
  audit: RealtimeAudit;
  instanceId: string;
  /** The connection's derived presence status may have changed (first lock acquired or last one released). */
  onStatusChanged: (connection: Connection) => void;
}

function holderOf(record: Pick<LockRecord, 'userId' | 'displayName' | 'color'>) {
  return { userId: record.userId, displayName: record.displayName, color: record.color };
}

export class LockService {
  readonly #deps: LockServiceDeps;
  readonly #log: Logger;

  constructor(deps: LockServiceDeps) {
    this.#deps = deps;
    this.#log = deps.logger.child({ component: 'locks' });
  }

  async acquire(connection: Connection, data: LockAcquireData, ref: string | null): Promise<void> {
    const { areaId, scope } = data;
    const limit = this.#deps.config.WS_MAX_LOCKS_PER_CONNECTION;
    const held = connection.locks.get(areaId);
    if (held === undefined && connection.locks.size >= limit) {
      this.#deny(
        connection,
        areaId,
        'LOCK_LIMIT_REACHED',
        `A connection holds at most ${limit} locks.`,
        ref,
        {
          limit,
        },
      );
      return;
    }
    const bbox = held?.bbox ?? (await this.#areaBbox(connection, areaId, ref));
    if (bbox === null) return;

    const ttlMs = this.#deps.config.REALTIME_LOCK_TTL_MS;
    const now = this.#deps.clock.now();
    const expiresAt = new Date(now + ttlMs).toISOString();
    const record: LockRecord = {
      ...holderOf(connection.identity),
      scope,
      connectionId: connection.id,
      instanceId: this.#deps.instanceId,
      bbox,
      acquiredAt: new Date(now).toISOString(),
      expiresAt,
    };
    let result;
    try {
      result = await this.#deps.store.acquire(areaId, record, ttlMs);
    } catch (error) {
      this.#log.warn({ err: error, areaId }, 'lock store unavailable');
      this.#deny(connection, areaId, 'LOCK_UNAVAILABLE', 'Soft locks are temporarily unavailable.', ref);
      return;
    }
    if (!result.acquired) {
      // A lock we held expired and someone else took it: forget it locally.
      if (held !== undefined) this.#forget(connection, areaId);
      const holder = result.holder;
      this.#deny(
        connection,
        areaId,
        'LOCK_HELD',
        holder === null
          ? 'The area is locked by another user.'
          : `${holder.displayName} is editing this area.`,
        ref,
        holder === null ? {} : { holder: holderOf(holder), scope: holder.scope, expiresAt: holder.expiresAt },
      );
      return;
    }

    connection.locks.set(areaId, { areaId, bbox, scope });
    connection.send(criticalMessage('lock.acquired', { areaId, expiresAt }, { ref }));
    await this.#deps.events.publish('locks', {
      areaId,
      bbox,
      holder: holderOf(record),
      scope,
      expiresAt,
    });
    if (held === undefined) {
      connection.counts.locks += 1;
      this.#deps.audit.lockAcquired(connection, areaId, scope);
      this.#deps.onStatusChanged(connection);
    }
  }

  async release(connection: Connection, data: LockReleaseData, ref: string | null): Promise<void> {
    const held = connection.locks.get(data.areaId);
    if (held !== undefined) {
      this.#forget(connection, data.areaId);
      await this.#releaseInStore(connection, held, 'client');
    }
    // Idempotent: releasing a lock that is not held is acknowledged too.
    if (ref !== null) connection.send(ackMessage(ref));
  }

  /** Socket closed or instance stopping: release every lock of the connection. */
  async releaseAll(connection: Connection): Promise<void> {
    const held = [...connection.locks.values()];
    connection.locks.clear();
    for (const lock of held) await this.#releaseInStore(connection, lock, 'disconnect');
  }

  /** All active locks for `lock.snapshot` (<= 500); empty while Redis is unreachable. */
  async snapshot(): Promise<LockSnapshotItem[]> {
    let locks: Map<string, LockRecord>;
    try {
      locks = await this.#deps.store.all();
    } catch (error) {
      this.#log.warn({ err: error }, 'lock snapshot unavailable (Redis); sending an empty snapshot');
      return [];
    }
    const now = this.#deps.clock.now();
    return [...locks.entries()]
      .filter(([, record]) => Date.parse(record.expiresAt) > now)
      .slice(0, PROTOCOL_LIMITS.lockSnapshotMax)
      .map(([areaId, record]) => ({
        areaId,
        holder: holderOf(record),
        scope: record.scope,
        expiresAt: record.expiresAt,
      }));
  }

  /** The live area's bbox, or null after answering AREA_NOT_FOUND / LOCK_UNAVAILABLE. */
  async #areaBbox(connection: Connection, areaId: string, ref: string | null): Promise<Bbox | null> {
    try {
      const bbox = await this.#deps.areasReader.getBbox(areaId);
      if (bbox === null)
        this.#deny(connection, areaId, 'AREA_NOT_FOUND', `Area ${areaId} does not exist.`, ref);
      return bbox;
    } catch (error) {
      this.#log.warn({ err: error, areaId }, 'area lookup for a lock failed');
      this.#deny(connection, areaId, 'LOCK_UNAVAILABLE', 'Soft locks are temporarily unavailable.', ref);
      return null;
    }
  }

  async #releaseInStore(
    connection: Connection,
    lock: HeldLock,
    reason: 'client' | 'disconnect',
  ): Promise<void> {
    let released = false;
    try {
      released = await this.#deps.store.release(lock.areaId, connection.id);
    } catch (error) {
      this.#log.warn(
        { err: error, areaId: lock.areaId },
        'lock release failed; the lock expires with its TTL',
      );
    }
    if (!released) return;
    await this.#deps.events.publish('locks', {
      areaId: lock.areaId,
      bbox: lock.bbox,
      holder: null,
      scope: null,
      expiresAt: null,
    });
    this.#deps.audit.lockReleased(connection, lock.areaId, reason);
  }

  #forget(connection: Connection, areaId: string): void {
    connection.locks.delete(areaId);
    this.#deps.onStatusChanged(connection);
  }

  #deny(
    connection: Connection,
    areaId: string,
    code: LockDenialCode,
    message: string,
    ref: string | null,
    details?: Record<string, unknown>,
  ): void {
    this.#deps.audit.denied('lock.acquire', code, connection, areaId);
    connection.send(errorMessage(code, message, { ref, ...(details === undefined ? {} : { details }) }));
  }
}
