import type { PresenceDto } from '@snapland/shared';
import { describe, expect, it } from 'vitest';

import { buildPresenceSnapshot } from './presence.js';
import { parseEntry, serializeEntry } from './presence-store.js';

function entry(n: number, userId: string, updatedAt: string): PresenceDto {
  return {
    connectionId: `c0000000-0000-4000-8000-${String(n).padStart(12, '0')}`,
    userId,
    displayName: `User ${n}`,
    color: '#c44f9d',
    status: 'viewing',
    activeAreaId: null,
    viewport: null,
    connectedAt: '2026-09-27T10:00:00.000Z',
    updatedAt,
  };
}

const U1 = 'a0000000-0000-4000-8000-000000000001';
const U2 = 'a0000000-0000-4000-8000-000000000002';

describe('buildPresenceSnapshot (section 7.7)', () => {
  it('orders by updatedAt (most recent first), cuts at max and counts distinct users over all entries', () => {
    const entries = [
      entry(1, U1, '2026-09-27T10:00:01.000Z'),
      entry(2, U1, '2026-09-27T10:00:03.000Z'),
      entry(3, U2, '2026-09-27T10:00:02.000Z'),
    ];
    const snapshot = buildPresenceSnapshot(entries, 2);
    expect(snapshot.items.map((item) => item.displayName)).toEqual(['User 2', 'User 3']);
    expect(snapshot.onlineCount).toBe(2);
    expect(snapshot.truncated).toBe(true);
  });

  it('is not truncated when everything fits', () => {
    const snapshot = buildPresenceSnapshot([entry(1, U1, '2026-09-27T10:00:01.000Z')], 500);
    expect(snapshot).toMatchObject({ onlineCount: 1, truncated: false });
    expect(buildPresenceSnapshot([], 500)).toEqual({ items: [], onlineCount: 0, truncated: false });
  });
});

describe('presence registry entries', () => {
  it('store the DTO plus the owning instance and parse back to the DTO', () => {
    const dto = entry(1, U1, '2026-09-27T10:00:01.000Z');
    const raw = serializeEntry(dto, 'backend-1');
    expect(JSON.parse(raw)).toMatchObject({ instanceId: 'backend-1' });
    expect(parseEntry(raw)).toEqual(dto);
  });

  it('ignore corrupt entries', () => {
    expect(parseEntry('not json')).toBeNull();
    expect(parseEntry('{"connectionId":"x"}')).toBeNull();
  });
});
