import { describe, expect, it } from 'vitest';

import type { Connection } from './connection.js';
import { ConnectionRegistry } from './connection-registry.js';

const LIMITS = { maxPerInstance: 3, maxPerUser: 2 };

/** The registry reads only `id` and `identity`: a structural test double is enough. */
function fakeConnection(id: string, userId: string, sessionId: string): Connection {
  return { id, identity: { userId, sessionId } } as unknown as Connection;
}

function reserve(registry: ConnectionRegistry, userId: string) {
  const result = registry.tryReserve(userId, LIMITS);
  if (!result.ok) throw new Error(`reservation refused: ${result.reason}`);
  return result.reservation;
}

describe('ConnectionRegistry (section 7.2 capacity)', () => {
  it('refuses a user beyond the per-user cap, counting pending reservations', () => {
    const registry = new ConnectionRegistry();
    reserve(registry, 'u1');
    reserve(registry, 'u1');
    expect(registry.tryReserve('u1', LIMITS)).toEqual({ ok: false, reason: 'user_full' });
    expect(registry.tryReserve('u2', LIMITS).ok).toBe(true);
  });

  it('refuses beyond the instance cap and frees the slot when a reservation is released', () => {
    const registry = new ConnectionRegistry();
    const first = reserve(registry, 'u1');
    reserve(registry, 'u2');
    reserve(registry, 'u3');
    expect(registry.tryReserve('u4', LIMITS)).toEqual({ ok: false, reason: 'instance_full' });
    first.release();
    first.release();
    expect(registry.tryReserve('u4', LIMITS).ok).toBe(true);
  });

  it('converts a reservation on add and tracks sessions, users and removal', () => {
    const registry = new ConnectionRegistry();
    const a = fakeConnection('c1', 'u1', 's1');
    const b = fakeConnection('c2', 'u1', 's2');
    const reservationA = reserve(registry, 'u1');
    registry.add(a, reservationA);
    registry.add(b, reserve(registry, 'u1'));
    // Releasing an already converted reservation must not free a second slot.
    reservationA.release();
    expect(registry.size).toBe(2);
    expect(registry.tryReserve('u1', LIMITS)).toEqual({ ok: false, reason: 'user_full' });
    expect(registry.bySession('s2')).toEqual([b]);
    expect(registry.sessionIds().sort()).toEqual(['s1', 's2']);
    expect(registry.remove(a)).toBe(true);
    expect(registry.remove(a)).toBe(false);
    // The removed connection's slot is free again for its user.
    expect(registry.tryReserve('u1', LIMITS).ok).toBe(true);
    expect([...registry.values()]).toEqual([b]);
  });
});
