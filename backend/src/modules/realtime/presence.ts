/**
 * Presence (SPEC section 7.7): the Redis registry of every instance's connections, broadcast of joined/updated/left over the
 * `presence` bus channel (per-connection updates coalesced to <= 1/s), the periodic refresh that re-adds entries a
 * sweeper removed after an event-loop stall, and the sweeper that removes entries of crashed instances. Redis failures
 * degrade to local-only presence (snapshot from this instance's connections), never to errors.
 */
import type { PresenceDto, PresenceListResponse } from '@snapland/shared';

import type { AppConfig } from '../../config/env.js';
import type { Clock } from '../../infra/clock.js';
import type { EventBus } from '../../infra/events/types.js';
import { KeyedThrottle } from '../../infra/keyed-throttle.js';
import { runDetached } from '../../infra/lifecycle.js';
import type { Logger } from '../../infra/logger.js';
import type { Metrics } from '../../infra/metrics/metrics.js';
import type { Connection } from './connection.js';
import type { ConnectionRegistry } from './connection-registry.js';
import { derivePresenceStatus } from './presence-status.js';
import type { PresenceStore } from './presence-store.js';
import { PROTOCOL_LIMITS } from './protocol-limits.js';
import { repeat, unrefTimeout } from './timers.js';
import type { Cancel } from './timers.js';

export interface PresenceServiceDeps {
  store: PresenceStore;
  events: EventBus;
  registry: ConnectionRegistry;
  clock: Clock;
  logger: Logger;
  metrics: Metrics;
  config: Pick<
    AppConfig,
    'REALTIME_PRESENCE_REFRESH_MS' | 'REALTIME_PRESENCE_SWEEP_MS' | 'REALTIME_PRESENCE_STALE_MS'
  >;
}

/** Redis failures repeat on every refresh/sweep: warn at most once per operation per interval. */
const WARN_INTERVAL_MS = 30_000;

/**
 * The snapshot view (section 7.7): most recently updated first, at most `max` items, `onlineCount` = distinct users over
 * ALL entries and `truncated` when entries were cut.
 */
export function buildPresenceSnapshot(entries: readonly PresenceDto[], max: number): PresenceListResponse {
  const sorted = [...entries].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  return {
    items: sorted.slice(0, max),
    onlineCount: new Set(entries.map((entry) => entry.userId)).size,
    truncated: sorted.length > max,
  };
}

export class PresenceService {
  readonly #deps: PresenceServiceDeps;
  readonly #log: Logger;
  readonly #warnings = new KeyedThrottle(WARN_INTERVAL_MS, 16);
  /** Trailing publish scheduled per connection (<= 1 publish per second). */
  readonly #pending = new Map<string, Cancel>();
  readonly #lastPublished = new Map<string, number>();
  #stopLoops: Cancel[] = [];

  constructor(deps: PresenceServiceDeps) {
    this.#deps = deps;
    this.#log = deps.logger.child({ component: 'presence' });
  }

  /** The connection's current PresenceDto (status derived server-side, section 7.7). */
  presenceOf(connection: Connection): PresenceDto {
    const { status, activeAreaId } = derivePresenceStatus({
      reported: connection.reportedStatus,
      draft: connection.draft,
      lockedAreaIds: [...connection.locks.keys()],
    });
    const { identity } = connection;
    return {
      connectionId: connection.id,
      userId: identity.userId,
      displayName: identity.displayName,
      color: identity.color,
      status,
      activeAreaId,
      viewport: connection.viewport,
      connectedAt: new Date(connection.connectedAt).toISOString(),
      updatedAt: new Date(connection.presenceUpdatedAt).toISOString(),
    };
  }

  /** Registry snapshot (<= 500 items); falls back to this instance's connections while Redis is unreachable. */
  async snapshot(): Promise<PresenceListResponse> {
    let entries: PresenceDto[];
    try {
      entries = await this.#deps.store.all();
    } catch (error) {
      this.#warn('snapshot', error, 'presence registry unavailable; serving local presence only');
      entries = [...this.#deps.registry.values()]
        .filter((connection) => connection.presenceRegistered)
        .map((connection) => this.presenceOf(connection));
    }
    const snapshot = buildPresenceSnapshot(entries, PROTOCOL_LIMITS.presenceSnapshotMax);
    this.#deps.metrics.presenceOnlineUsers.set(snapshot.onlineCount);
    return snapshot;
  }

  /** Registers the connection and announces `presence.joined` (after welcome and the snapshots, section 7.2 step 4). */
  async join(connection: Connection): Promise<void> {
    if (!connection.isOpen) return;
    // Marked first: if the write fails, the next refresh re-adds the entry.
    connection.presenceRegistered = true;
    const presence = this.presenceOf(connection);
    this.#lastPublished.set(connection.id, this.#deps.clock.now());
    await this.#write(presence);
    await this.#deps.events.publish('presence', {
      kind: 'joined',
      presence,
      connectionId: connection.id,
      userId: connection.identity.userId,
    });
  }

  /** Status, viewport, draft or lock state changed: broadcast `presence.updated`, coalesced to <= 1 per second. */
  changed(connection: Connection): void {
    connection.presenceUpdatedAt = this.#deps.clock.now();
    if (!connection.presenceRegistered || !connection.isOpen || this.#pending.has(connection.id)) return;
    const last = this.#lastPublished.get(connection.id) ?? 0;
    const waitMs = last + PROTOCOL_LIMITS.presencePublishIntervalMs - this.#deps.clock.now();
    if (waitMs <= 0) {
      runDetached(this.#publishUpdate(connection), this.#log, 'presence.update');
      return;
    }
    this.#pending.set(
      connection.id,
      unrefTimeout(() => {
        this.#pending.delete(connection.id);
        runDetached(this.#publishUpdate(connection), this.#log, 'presence.update');
      }, waitMs),
    );
  }

  /** Removes the entry and announces `presence.left` (socket closed or instance stopping). */
  async leave(connection: Connection): Promise<void> {
    this.#pending.get(connection.id)?.();
    this.#pending.delete(connection.id);
    this.#lastPublished.delete(connection.id);
    if (!connection.presenceRegistered) return;
    connection.presenceRegistered = false;
    try {
      await this.#deps.store.remove(connection.id);
    } catch (error) {
      this.#warn('leave', error, 'presence entry removal failed; the sweeper removes it');
    }
    await this.#deps.events.publish('presence', {
      kind: 'left',
      connectionId: connection.id,
      userId: connection.identity.userId,
    });
  }

  /** Starts the refresh and sweep loops (idempotent). */
  start(): void {
    if (this.#stopLoops.length > 0) return;
    const { config } = this.#deps;
    const onError = (error: unknown): void => {
      this.#log.error({ err: error }, 'presence background task failed');
    };
    this.#stopLoops = [
      repeat(
        () => config.REALTIME_PRESENCE_REFRESH_MS,
        () => this.#refresh(),
        onError,
      ),
      repeat(
        () => config.REALTIME_PRESENCE_SWEEP_MS,
        () => this.#sweep(),
        onError,
      ),
    ];
  }

  /** Stops the loops and every pending coalesced publish. Idempotent. */
  stop(): void {
    for (const stop of this.#stopLoops) stop();
    this.#stopLoops = [];
    for (const cancel of this.#pending.values()) cancel();
    this.#pending.clear();
  }

  /**
   * Marks every registered local connection as seen; entries a sweeper removed meanwhile are re-added and
   * re-announced with `presence.joined`.
   */
  async #refresh(): Promise<void> {
    const live = [...this.#deps.registry.values()].filter(
      (connection) => connection.presenceRegistered && connection.isOpen,
    );
    const now = this.#deps.clock.now();
    for (let start = 0; start < live.length; start += PROTOCOL_LIMITS.presenceRefreshBatch) {
      const batch = live.slice(start, start + PROTOCOL_LIMITS.presenceRefreshBatch);
      const byId = new Map(batch.map((connection) => [connection.id, connection]));
      let readded: string[];
      try {
        readded = await this.#deps.store.refresh(
          batch.map((connection) => this.presenceOf(connection)),
          now,
        );
      } catch (error) {
        this.#warn('refresh', error, 'presence refresh failed (Redis unavailable)');
        return;
      }
      for (const connectionId of readded) {
        const connection = byId.get(connectionId);
        if (connection === undefined) continue;
        this.#log.info({ connectionId }, 'presence entry was swept while live; re-announced');
        await this.#deps.events.publish('presence', {
          kind: 'joined',
          presence: this.presenceOf(connection),
          connectionId,
          userId: connection.identity.userId,
        });
      }
    }
  }

  /** Removes entries not seen for REALTIME_PRESENCE_STALE_MS (crashed instances) and announces `presence.left`. */
  async #sweep(): Promise<void> {
    const cutoff = this.#deps.clock.now() - this.#deps.config.REALTIME_PRESENCE_STALE_MS;
    let swept;
    try {
      swept = await this.#deps.store.sweep(cutoff, PROTOCOL_LIMITS.presenceSweepBatch);
    } catch (error) {
      this.#warn('sweep', error, 'presence sweep failed (Redis unavailable)');
      return;
    }
    for (const entry of swept) {
      if (entry.presence === null) continue;
      await this.#deps.events.publish('presence', {
        kind: 'left',
        connectionId: entry.connectionId,
        userId: entry.presence.userId,
      });
    }
    if (swept.length > 0) this.#log.info({ swept: swept.length }, 'stale presence entries swept');
  }

  async #publishUpdate(connection: Connection): Promise<void> {
    if (!connection.presenceRegistered || !connection.isOpen) return;
    this.#lastPublished.set(connection.id, this.#deps.clock.now());
    const presence = this.presenceOf(connection);
    await this.#write(presence);
    await this.#deps.events.publish('presence', {
      kind: 'updated',
      presence,
      connectionId: connection.id,
      userId: connection.identity.userId,
    });
  }

  async #write(presence: PresenceDto): Promise<void> {
    try {
      await this.#deps.store.upsert(presence, this.#deps.clock.now());
    } catch (error) {
      this.#warn('write', error, 'presence write failed; local-only presence until Redis returns');
    }
  }

  #warn(operation: string, error: unknown, message: string): void {
    if (this.#warnings.shouldFire(operation, this.#deps.clock.now())) this.#log.warn({ err: error }, message);
  }
}
