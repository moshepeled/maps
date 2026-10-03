/**
 * Cross-instance fan-out (SPEC section 7.10, R40): two app instances in one process sharing PostgreSQL and Redis. An `areas`
 * bus event published through instance A reaches an intersecting WebSocket client on instance B as `area.changed`
 * within 500 ms (the REST -> WS path is T9's system test); drafts, presence and locks travel the same way.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createTestApp } from '../../helpers/test-app.js';
import type { TestApp } from '../../helpers/test-app.js';
import { createUser } from '../../helpers/users.js';
import type { TestUser } from '../../helpers/users.js';
import {
  EILAT_VIEWPORT,
  FAST_REALTIME,
  areaChangedPayload,
  clientPool,
  delay,
  insertArea,
  newId,
} from './realtime-harness.js';
import type { ClientPool, ServerMessage } from './realtime-harness.js';

/** Idle expiry is not under test here (drafts.int covers it); keep drafts alive through slow CI moments. */
const CONFIG = { ...FAST_REALTIME, REALTIME_DRAFT_IDLE_MS: 5000 };

let instanceA: TestApp;
let instanceB: TestApp;
/** Clients connect to instance A unless the test says `{ app: instanceB }`. */
let pool: ClientPool;
let alice: TestUser;
let bob: TestUser;

beforeAll(async () => {
  [instanceA, instanceB] = await Promise.all([
    createTestApp({ config: CONFIG }),
    createTestApp({ config: CONFIG }),
  ]);
  pool = clientPool(instanceA);
  [alice, bob] = await Promise.all([
    createUser(instanceA.container, { displayName: 'Alice' }),
    createUser(instanceA.container, { displayName: 'Bob' }),
  ]);
});

afterAll(async () => {
  await pool.closeAll();
  await Promise.all([instanceA.close(), instanceB.close()]);
});

const areaChanged = (areaId: string) => (message: ServerMessage) =>
  message.type === 'area.changed' && (message.data['area'] as { id: string }).id === areaId;

describe('areas events across instances (section 7.10)', () => {
  it('reach an intersecting client on the other instance within 500 ms, and nobody outside the interest', async () => {
    const inView = await pool.connect(bob, { app: instanceB });
    const elsewhere = await pool.connect(alice, { app: instanceB, viewport: EILAT_VIEWPORT });
    const payload = areaChangedPayload(alice, [34.78, 32.08, 34.79, 32.09], 4242);
    const publishedAt = Date.now();
    await instanceA.container.events.publish('areas', payload);
    const received = await inView.waitFor(areaChanged(payload.area.id), 2000);
    expect(Date.now() - publishedAt).toBeLessThanOrEqual(500);
    expect(received.data).toMatchObject({
      changeSeq: 4242,
      op: 'create',
      merged: false,
      previousName: null,
      actor: { id: alice.id },
    });
    expect(received.data).not.toHaveProperty('prevBbox');
    await delay(500);
    expect(elsewhere.messages.some(areaChanged(payload.area.id))).toBe(false);
  });

  it('are delivered to clients that only see the previous bbox (an area moved out of their view)', async () => {
    const watchingOldPlace = await pool.connect(bob, { app: instanceB, viewport: EILAT_VIEWPORT });
    const payload = {
      ...areaChangedPayload(alice, [34.78, 32.08, 34.79, 32.09], 4243),
      op: 'update' as const,
      prevBbox: [34.92, 29.52, 34.93, 29.53] as [number, number, number, number],
      changedFields: ['geometry' as const],
    };
    await instanceA.container.events.publish('areas', payload);
    await watchingOldPlace.waitFor(areaChanged(payload.area.id), 2000);
  });
});

describe('drafts, presence and locks across instances', () => {
  it('relays a draft drawn on A to a viewer on B, then its end', async () => {
    const viewer = await pool.connect(bob, { app: instanceB });
    const drawer = await pool.connect(alice);
    const draftId = newId();
    expect((await drawer.request('draft.start', { draftId, areaId: null, resume: false })).type).toBe('ack');
    drawer.send({
      type: 'draft.update',
      data: {
        draftId,
        rev: 1,
        vertices: [
          [34.781, 32.081],
          [34.785, 32.081],
          [34.785, 32.085],
        ],
        cursor: null,
      },
    });
    const updated = await viewer.waitFor(
      (message) =>
        message.type === 'draft.updated' && message.data['draftId'] === draftId && message.data['rev'] === 1,
    );
    expect(updated.data['user']).toEqual({ id: alice.id, displayName: 'Alice', color: alice.color });
    expect((await drawer.request('draft.end', { draftId, outcome: 'cancelled', areaId: null })).type).toBe(
      'ack',
    );
    await viewer.waitFor(
      (message) =>
        message.type === 'draft.ended' &&
        message.data['draftId'] === draftId &&
        message.data['outcome'] === 'cancelled',
    );
  });

  it('shows a connection on A in the presence of a client on B', async () => {
    const watcher = await pool.connect(bob, { app: instanceB });
    const newcomer = await pool.connect(alice);
    const connectionId = String(newcomer.ofType('welcome')[0]?.data['connectionId']);
    await watcher.waitFor(
      (message) =>
        message.type === 'presence.joined' &&
        (message.data['presence'] as { connectionId: string }).connectionId === connectionId,
    );
    await newcomer.close();
    await watcher.waitFor(
      (message) => message.type === 'presence.left' && message.data['connectionId'] === connectionId,
    );
  });

  it('shares soft locks: a lock taken on A is announced on B and refused to another user there', async () => {
    const areaId = await insertArea(instanceA.container, alice.id);
    const holder = await pool.connect(alice);
    const other = await pool.connect(bob, { app: instanceB });
    expect((await holder.request('lock.acquire', { areaId, scope: 'geometry' })).type).toBe('lock.acquired');
    await other.waitFor((message) => message.type === 'lock.changed' && message.data['areaId'] === areaId);
    expect(await other.request('lock.acquire', { areaId, scope: 'details' })).toMatchObject({
      type: 'error',
      data: { code: 'LOCK_HELD', details: { holder: { userId: alice.id } } },
    });
  });
});
