/**
 * Edit soft locks (SPEC section 7.9 v1.2): acquire/renew/release, LOCK_HELD details, the per-connection cap
 * (LOCK_LIMIT_REACHED, renewals free), auto-release on close, lock.snapshot for late joiners, field TTL expiry,
 * LOCK_UNAVAILABLE with Redis unreachable, and coalesced audit rows for denials (section 10.4).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { InMemoryAuditLogger } from '../../../src/infra/audit/in-memory.js';
import { createMemoryAudit } from '../../helpers/audit.js';
import { createTcpProxy } from '../../helpers/tcp-proxy.js';
import type { TcpProxy } from '../../helpers/tcp-proxy.js';
import { createTestApp } from '../../helpers/test-app.js';
import type { TestApp } from '../../helpers/test-app.js';
import { createSession, createUser } from '../../helpers/users.js';
import type { TestUser } from '../../helpers/users.js';
import { waitFor } from '../../helpers/wait-for.js';
import { FAST_REALTIME, clientPool, delay, insertArea, newId } from './realtime-harness.js';
import type { ClientPool, ServerMessage, WsClient } from './realtime-harness.js';

let testApp: TestApp;
let pool: ClientPool;
let audit: InMemoryAuditLogger;
let alice: TestUser;
let bob: TestUser;

beforeAll(async () => {
  audit = createMemoryAudit();
  testApp = await createTestApp({ config: FAST_REALTIME, overrides: { audit } });
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

function acquire(client: WsClient, areaId: string, scope: 'geometry' | 'details' = 'geometry') {
  return client.request('lock.acquire', { areaId, scope });
}

const lockChanged = (areaId: string, holderId: string | null) => (message: ServerMessage) =>
  message.type === 'lock.changed' &&
  message.data['areaId'] === areaId &&
  ((message.data['holder'] as { userId: string } | null)?.userId ?? null) === holderId;

describe('acquire, hold, release (section 7.9)', () => {
  it('grants a free lock, tells the viewers, and refuses another user with LOCK_HELD details', async () => {
    const viewer = await pool.connect(bob);
    const holder = await pool.connect(alice);
    const areaId = await insertArea(testApp.container, alice.id);
    const acquired = await acquire(holder, areaId, 'details');
    expect(acquired.type).toBe('lock.acquired');
    expect(acquired.data['areaId']).toBe(areaId);
    expect(Date.parse(String(acquired.data['expiresAt']))).toBeGreaterThan(Date.now());
    const changed = await viewer.waitFor(lockChanged(areaId, alice.id));
    expect(changed.data).toMatchObject({
      holder: { userId: alice.id, displayName: 'Alice', color: alice.color },
      scope: 'details',
    });

    const refused = await acquire(viewer, areaId);
    expect(refused).toMatchObject({
      type: 'error',
      data: {
        code: 'LOCK_HELD',
        details: { holder: { userId: alice.id, displayName: 'Alice', color: alice.color }, scope: 'details' },
      },
    });
    expect(typeof (refused.data['details'] as { expiresAt: unknown }).expiresAt).toBe('string');

    expect((await holder.request('lock.release', { areaId })).type).toBe('ack');
    await viewer.waitFor(lockChanged(areaId, null));
    expect((await acquire(viewer, areaId)).type).toBe('lock.acquired');
  });

  it('lets the same user take over from another tab, answers AREA_NOT_FOUND for unknown areas', async () => {
    const tab1 = await pool.connect(alice);
    const tab2 = await pool.connect(alice, { sessionId: await createSession(testApp.container, alice.id) });
    const areaId = await insertArea(testApp.container, alice.id);
    expect((await acquire(tab1, areaId)).type).toBe('lock.acquired');
    expect((await acquire(tab2, areaId)).type).toBe('lock.acquired');
    expect(await acquire(tab1, newId())).toMatchObject({ type: 'error', data: { code: 'AREA_NOT_FOUND' } });
  });

  it('releases every lock of a connection when it closes and shows existing locks to late joiners', async () => {
    const holder = await pool.connect(alice);
    const areaId = await insertArea(testApp.container, alice.id);
    expect((await acquire(holder, areaId)).type).toBe('lock.acquired');
    const late = await pool.connect(bob);
    const snapshot = late.ofType('lock.snapshot')[0]?.data['items'] as {
      areaId: string;
      holder: { userId: string };
    }[];
    expect(snapshot.some((item) => item.areaId === areaId && item.holder.userId === alice.id)).toBe(true);

    await holder.close();
    await late.waitFor(lockChanged(areaId, null));
    expect(await testApp.container.redis.cmd.hexists(testApp.container.keys.locks(), areaId)).toBe(0);
  });

  it('expires a lock that is not renewed (REALTIME_LOCK_TTL_MS = 1000)', async () => {
    const holder = await pool.connect(alice);
    const areaId = await insertArea(testApp.container, alice.id);
    expect((await acquire(holder, areaId)).type).toBe('lock.acquired');
    await waitFor(
      async () => (await testApp.container.redis.cmd.hexists(testApp.container.keys.locks(), areaId)) === 0,
      { timeoutMs: 3000 },
    );
    const late = await pool.connect(bob);
    const items = late.ofType('lock.snapshot')[0]?.data['items'] as { areaId: string }[];
    expect(items.some((item) => item.areaId === areaId)).toBe(false);
  });
});

describe('per-connection cap (section 7.9 v1.2)', () => {
  it('refuses a 4th distinct lock with LOCK_LIMIT_REACHED while renewals of the first three still succeed', async () => {
    const editor = await pool.connect(alice);
    const areas = await Promise.all([1, 2, 3, 4].map(() => insertArea(testApp.container, alice.id)));
    const [first, second, third, fourth] = areas as [string, string, string, string];
    for (const areaId of [first, second, third])
      expect((await acquire(editor, areaId)).type).toBe('lock.acquired');
    expect(await acquire(editor, fourth)).toMatchObject({
      type: 'error',
      data: { code: 'LOCK_LIMIT_REACHED', details: { limit: 3 } },
    });
    for (const areaId of [first, second, third]) {
      const renewed = await acquire(editor, areaId);
      expect(renewed.type).toBe('lock.acquired');
    }
    expect((await editor.request('lock.release', { areaId: first })).type).toBe('ack');
    expect((await acquire(editor, fourth)).type).toBe('lock.acquired');
  });

  it('audits 100 denials of one connection in 10 s as coalesced rows whose counts sum to 100', async () => {
    const editor = await pool.connect(bob);
    const areas = await Promise.all([1, 2, 3].map(() => insertArea(testApp.container, bob.id)));
    for (const areaId of areas) expect((await acquire(editor, areaId)).type).toBe('lock.acquired');
    const extra = newId();
    for (let i = 0; i < 100; i += 1) {
      if (i >= 30) await delay(55); // stay under the 20 msg/s inbound bucket
      const reply = await acquire(editor, extra);
      expect(reply.data['code']).toBe('LOCK_LIMIT_REACHED');
    }
    await testApp.container.auditCoalescer.flush();
    const rows = audit.find(
      (event) =>
        event.action === 'lock.acquire' &&
        event.outcome === 'denied' &&
        event.details['code'] === 'LOCK_LIMIT_REACHED' &&
        event.targetId === extra,
    );
    // The first denial is written at once, the other 99 as ONE aggregated row when the window closes.
    expect(rows.length).toBeLessThanOrEqual(2);
    expect(rows.reduce((sum, row) => sum + Number(row.details['count']), 0)).toBe(100);
    expect(rows.every((row) => row.actorId === bob.id)).toBe(true);
  });
});

describe('degradation (section 7.9, section 10.6)', () => {
  it('answers LOCK_UNAVAILABLE while Redis is unreachable, and works again afterwards', async () => {
    let proxy: TcpProxy | undefined;
    let degraded: TestApp | undefined;
    try {
      proxy = await createTcpProxy(testApp.config.REDIS_URL);
      degraded = await createTestApp({ config: { ...FAST_REALTIME, REDIS_URL: proxy.url } });
      const user = await createUser(degraded.container);
      const areaId = await insertArea(degraded.container, user.id);
      const client = await pool.connect(user, { app: degraded });
      proxy.pause();
      expect(await acquire(client, areaId)).toMatchObject({
        type: 'error',
        data: { code: 'LOCK_UNAVAILABLE' },
      });
      proxy.resume();
      await waitFor(async () => (await acquire(client, areaId)).type === 'lock.acquired', {
        timeoutMs: 8000,
      });
    } finally {
      proxy?.resume();
      await degraded?.close();
      await proxy?.close();
    }
  });
});
