/**
 * The connections of this instance (SPEC section 7.2 step 5, section 7.8): lookup by session, per-user counts, and capacity
 * reservations. A reservation is taken in the upgrade's preValidation (before the 101) and converted when the socket
 * is registered, so concurrent upgrades cannot overshoot WS_MAX_CONNECTIONS_PER_INSTANCE / _PER_USER.
 */
import type { Connection } from './connection.js';

export type ReservationResult =
  { ok: true; reservation: Reservation } | { ok: false; reason: 'instance_full' | 'user_full' };

export interface Reservation {
  readonly userId: string;
  /** Returns the slot (upgrade failed or aborted). No-op after `add()` converted it, and idempotent. */
  release(): void;
}

export interface CapacityLimits {
  maxPerInstance: number;
  maxPerUser: number;
}

export class ConnectionRegistry {
  readonly #connections = new Map<string, Connection>();
  readonly #perUser = new Map<string, number>();
  #reserved = 0;
  readonly #reservedPerUser = new Map<string, number>();

  get size(): number {
    return this.#connections.size;
  }

  values(): IterableIterator<Connection> {
    return this.#connections.values();
  }

  bySession(sessionId: string): Connection[] {
    return [...this.#connections.values()].filter(
      (connection) => connection.identity.sessionId === sessionId,
    );
  }

  /** Distinct session ids of the local connections (re-validation input). */
  sessionIds(): string[] {
    return [...new Set([...this.#connections.values()].map((connection) => connection.identity.sessionId))];
  }

  tryReserve(userId: string, limits: CapacityLimits): ReservationResult {
    if (this.#connections.size + this.#reserved >= limits.maxPerInstance)
      return { ok: false, reason: 'instance_full' };
    const userTotal = (this.#perUser.get(userId) ?? 0) + (this.#reservedPerUser.get(userId) ?? 0);
    if (userTotal >= limits.maxPerUser) return { ok: false, reason: 'user_full' };
    this.#reserved += 1;
    increment(this.#reservedPerUser, userId, 1);
    let active = true;
    return {
      ok: true,
      reservation: {
        userId,
        release: () => {
          if (!active) return;
          active = false;
          this.#reserved -= 1;
          increment(this.#reservedPerUser, userId, -1);
        },
      },
    };
  }

  /** Registers the upgraded connection, converting its reservation into a live slot. */
  add(connection: Connection, reservation: Reservation): void {
    reservation.release();
    this.#connections.set(connection.id, connection);
    increment(this.#perUser, connection.identity.userId, 1);
  }

  /** Removes the connection; false when it was not registered (idempotent). */
  remove(connection: Connection): boolean {
    if (!this.#connections.delete(connection.id)) return false;
    increment(this.#perUser, connection.identity.userId, -1);
    return true;
  }
}

function increment(counts: Map<string, number>, key: string, delta: number): void {
  const next = (counts.get(key) ?? 0) + delta;
  if (next <= 0) counts.delete(key);
  else counts.set(key, next);
}
