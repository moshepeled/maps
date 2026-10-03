/**
 * Presence (SPEC section 7.7 v1.2): server-derived status precedence (editing > drawing > reported), the sweeper of stale
 * entries, the refresh that re-adds a swept live entry, and local-only presence while Redis is unreachable. Timings:
 * refresh / sweep / stale = 200 / 200 / 600 ms.
 */
import { PresenceListResponseSchema } from '@snapland/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createTcpProxy } from '../../helpers/tcp-proxy.js';
import type { TcpProxy } from '../../helpers/tcp-proxy.js';
import { createTestApp } from '../../helpers/test-app.js';
import type { TestApp } from '../../helpers/test-app.js';
import { bearer, createUser } from '../../helpers/users.js';
import type { TestUser } from '../../helpers/users.js';
import { waitFor } from '../../helpers/wait-for.js';
import { FAST_REALTIME, clientPool, fakePresenceEntry, insertArea, newId } from './realtime-harness.js';
import type { ClientPool, ServerMessage, WsClient } from './realtime-harness.js';

/** Idle and lock expiry are not under test here: presence broadcasts are coalesced to 1/s (longer than the 1 s test TTLs). */
const CONFIG = { ...FAST_REALTIME, REALTIME_DRAFT_IDLE_MS: 5000, REALTIME_LOCK_TTL_MS: 5000 };

let testApp: TestApp;
let pool: ClientPool;
let alice: TestUser;
let bob: TestUser;

beforeAll(async () => {
  testApp = await createTestApp({ config: CONFIG });
  pool = clientPool(testApp);
  [alice, bob] = await Promise.all([
    createUser(testApp.container, { displayName: 'Alice' }),
    createUser(testApp.container, { displayName: 'Bob' }),
  ]);
});

afterAll(async () => {
  await pool.closeAll();
  await testApp.close();
});

function connectionIdOf(client: WsClient): string {
  return String(client.ofType('welcome')[0]?.data['connectionId']);
}

interface PresenceView {
  connectionId: string;
  status: string;
  activeAreaId: string | null;
}

function presenceUpdate(connectionId: string, status: string, activeAreaId: string | null) {
  return (message: ServerMessage): boolean => {
    if (message.type !== 'presence.updated' && message.type !== 'presence.joined') return false;
    const presence = message.data['presence'] as PresenceView;
    return (
      presence.connectionId === connectionId &&
      presence.status === status &&
      presence.activeAreaId === activeAreaId
    );
  };
}

describe('status precedence (section 7.7 v1.2)', () => {
  it('a new-area draft -> drawing with activeAreaId = draft id; after the end -> viewing again', async () => {
    const observer = await pool.connect(bob);
    const drawer = await pool.connect(alice);
    const id = connectionIdOf(drawer);
    const draftId = newId();
    expect((await drawer.request('draft.start', { draftId, areaId: null, resume: false })).type).toBe('ack');
    await observer.waitFor(presenceUpdate(id, 'drawing', draftId));
    expect((await drawer.request('draft.end', { draftId, outcome: 'cancelled', areaId: null })).type).toBe(
      'ack',
    );
    await observer.waitFor(presenceUpdate(id, 'viewing', null));
  });

  it('an edit draft (areaId set) -> editing with activeAreaId = areaId', async () => {
    const observer = await pool.connect(bob);
    const editor = await pool.connect(alice);
    const areaId = await insertArea(testApp.container, alice.id);
    const draftId = newId();
    expect((await editor.request('draft.start', { draftId, areaId, resume: false })).type).toBe('ack');
    await observer.waitFor(presenceUpdate(connectionIdOf(editor), 'editing', areaId));
  });

  it('a lock and an edit draft -> editing; the reported status only shows without draft and lock', async () => {
    const observer = await pool.connect(bob);
    const editor = await pool.connect(alice);
    const id = connectionIdOf(editor);
    const lockedArea = await insertArea(testApp.container, alice.id);
    const draftArea = await insertArea(testApp.container, alice.id);
    expect((await editor.request('presence.update', { status: 'idle' })).type).toBe('ack');
    await observer.waitFor(presenceUpdate(id, 'idle', null));
    expect((await editor.request('lock.acquire', { areaId: lockedArea, scope: 'geometry' })).type).toBe(
      'lock.acquired',
    );
    await observer.waitFor(presenceUpdate(id, 'editing', lockedArea));
    const draftId = newId();
    expect((await editor.request('draft.start', { draftId, areaId: draftArea, resume: false })).type).toBe(
      'ack',
    );
    await observer.waitFor(presenceUpdate(id, 'editing', draftArea));
    expect((await editor.request('draft.end', { draftId, outcome: 'cancelled', areaId: null })).type).toBe(
      'ack',
    );
    expect((await editor.request('lock.release', { areaId: lockedArea })).type).toBe('ack');
    await observer.waitFor(presenceUpdate(id, 'idle', null));
  });
});

describe('registry maintenance (section 7.7)', () => {
  it('sweeps entries not seen for REALTIME_PRESENCE_STALE_MS and announces presence.left', async () => {
    const observer = await pool.connect(bob);
    const { redis, keys } = testApp.container;
    const ghost = newId();
    const stale = Date.now() - 5000;
    await redis.cmd.hset(keys.presenceConns(), ghost, fakePresenceEntry(ghost, alice, stale));
    await redis.cmd.zadd(keys.presenceSeen(), stale, ghost);
    const left = await observer.waitFor(
      (message) => message.type === 'presence.left' && message.data['connectionId'] === ghost,
      3000,
    );
    expect(left.data['userId']).toBe(alice.id);
    expect(await redis.cmd.hexists(keys.presenceConns(), ghost)).toBe(0);
    expect(await redis.cmd.zscore(keys.presenceSeen(), ghost)).toBeNull();
  });

  it('re-adds a live connection whose entry was swept (event-loop stall) and re-announces it', async () => {
    const observer = await pool.connect(bob);
    const live = await pool.connect(alice);
    const id = connectionIdOf(live);
    const { redis, keys } = testApp.container;
    await waitFor(async () => (await redis.cmd.hexists(keys.presenceConns(), id)) === 1);
    const joinedBefore = observer.messages.filter(
      (message) =>
        message.type === 'presence.joined' && (message.data['presence'] as PresenceView).connectionId === id,
    ).length;
    await redis.cmd.hdel(keys.presenceConns(), id);
    await waitFor(async () => (await redis.cmd.hexists(keys.presenceConns(), id)) === 1, { timeoutMs: 3000 });
    await waitFor(
      () =>
        observer.messages.filter(
          (message) =>
            message.type === 'presence.joined' &&
            (message.data['presence'] as PresenceView).connectionId === id,
        ).length > joinedBefore,
      { timeoutMs: 3000 },
    );
    // A live connection is refreshed (seen) continuously, so the sweeper never removes it.
    const seen = Number(await redis.cmd.zscore(keys.presenceSeen(), id));
    expect(Date.now() - seen).toBeLessThan(1000);
  });

  it('degrades to local-only presence while Redis is unreachable (GET /presence still answers)', async () => {
    let proxy: TcpProxy | undefined;
    let degraded: TestApp | undefined;
    try {
      proxy = await createTcpProxy(testApp.config.REDIS_URL);
      degraded = await createTestApp({ config: { ...FAST_REALTIME, REDIS_URL: proxy.url } });
      const user = await createUser(degraded.container);
      const client = await pool.connect(user, { app: degraded });
      const id = connectionIdOf(client);
      proxy.pause();
      const response = await degraded.app.inject({
        method: 'GET',
        url: '/api/v1/presence',
        headers: bearer(user),
      });
      expect(response.statusCode).toBe(200);
      const body = PresenceListResponseSchema.parse(response.json());
      expect(body.items.some((item) => item.connectionId === id)).toBe(true);
      expect(client.closeCode).toBeNull();
    } finally {
      proxy?.resume();
      await degraded?.close();
      await proxy?.close();
    }
  });
});
