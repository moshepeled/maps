/**
 * Gateway basics (SPEC section 7.2 step 4, section 7.3, section 7.4, section 7.5, section 7.8, section 6.4, section 10.4, section 10.12): handshake message order, protocol
 * replies, validation errors, inbound throttling, the REST presence fallback, the ws.connect/ws.disconnect audit rows
 * and the graceful stop.
 */
import { PresenceListResponseSchema, parseServerMessage } from '@snapland/shared';
import { Redis } from 'ioredis';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { InMemoryAuditLogger } from '../../../src/infra/audit/in-memory.js';
import { createMemoryAudit } from '../../helpers/audit.js';
import { createTestApp } from '../../helpers/test-app.js';
import type { TestApp } from '../../helpers/test-app.js';
import { bearer, createUser } from '../../helpers/users.js';
import type { TestUser } from '../../helpers/users.js';
import { waitFor } from '../../helpers/wait-for.js';
import {
  FAST_REALTIME,
  TEL_AVIV_VIEWPORT,
  connectUser,
  delay,
  fakePresenceEntry,
  insertArea,
  issueTicket,
  newId,
  openClient,
} from './realtime-harness.js';

let testApp: TestApp;
let audit: InMemoryAuditLogger;
let alice: TestUser;
let bob: TestUser;

beforeAll(async () => {
  audit = createMemoryAudit();
  testApp = await createTestApp({ config: FAST_REALTIME, overrides: { audit } });
  alice = await createUser(testApp.container, { displayName: 'Alice' });
  bob = await createUser(testApp.container, { displayName: 'Bob' });
});

afterAll(async () => {
  await testApp.close();
});

describe('handshake (section 7.2 step 4)', () => {
  it('sends welcome, then presence.snapshot, then lock.snapshot - all valid under the loose shared schemas', async () => {
    const client = await connectUser(testApp, alice);
    const [welcome, presence, locks] = client.messages;
    expect(parseServerMessage(welcome)).toMatchObject({ kind: 'message', message: { type: 'welcome' } });
    expect(parseServerMessage(presence)).toMatchObject({
      kind: 'message',
      message: { type: 'presence.snapshot' },
    });
    expect(parseServerMessage(locks)).toMatchObject({ kind: 'message', message: { type: 'lock.snapshot' } });

    const data = welcome?.data ?? {};
    expect(typeof data['serverTime']).toBe('number');
    expect(Math.abs(Number(data['serverTime']) - Date.now())).toBeLessThan(5000);
    expect(data['latestChangeSeq']).toBe(await testApp.container.areasReader.latestChangeSeq());
    expect(data['instanceId']).toBe(testApp.container.instanceId);
    expect(data['user']).toEqual({ id: alice.id, displayName: 'Alice', color: alice.color });
    expect(data['heartbeatIntervalMs']).toBe(testApp.config.WS_PING_INTERVAL_MS);
    expect(data['limits']).toEqual({
      maxPayloadBytes: testApp.config.WS_MAX_PAYLOAD_BYTES,
      drawActionsPerWindow: testApp.config.DRAW_RATE_LIMIT_MAX,
      drawWindowMs: testApp.config.DRAW_RATE_LIMIT_WINDOW_MS,
      draftUpdateMinIntervalMs: 100,
      draftTouchIntervalMs: 300,
      maxPositions: 2000,
    });
    await client.close();
  });

  it('handles a frame sent right after the 101 behind the handshake: welcome first, then the pong', async () => {
    const ticket = await issueTicket(testApp.container, alice, alice.sessionId);
    const client = await openClient(testApp, ticket);
    client.send({ type: 'ping', ref: 'early', data: { t: 1 } });
    const pong = await client.waitFor((message) => message.ref === 'early');
    expect(pong.type).toBe('pong');
    expect(client.messages.slice(0, 3).map((message) => message.type)).toEqual([
      'welcome',
      'presence.snapshot',
      'lock.snapshot',
    ]);
    await client.close();
  });

  it('includes existing connections in presence.snapshot and announces the newcomer to the others', async () => {
    const first = await connectUser(testApp, alice, { viewport: TEL_AVIV_VIEWPORT });
    const second = await connectUser(testApp, bob);
    const snapshot = second.ofType('presence.snapshot')[0]?.data;
    const items = (snapshot?.['items'] ?? []) as { connectionId: string; userId: string }[];
    const firstId = String(first.ofType('welcome')[0]?.data['connectionId']);
    const secondId = String(second.ofType('welcome')[0]?.data['connectionId']);
    expect(items.some((item) => item.connectionId === firstId && item.userId === alice.id)).toBe(true);
    await first.waitFor(
      (message) =>
        message.type === 'presence.joined' &&
        (message.data['presence'] as { connectionId: string }).connectionId === secondId,
    );
    // presence.joined is not sent to its own subject (it knows itself from welcome).
    await delay(300);
    expect(
      second
        .ofType('presence.joined')
        .some((message) => (message.data['presence'] as { connectionId: string }).connectionId === secondId),
    ).toBe(false);
    await Promise.all([first.close(), second.close()]);
    await first.closed;
  });
});

describe('protocol replies (section 7.3, section 7.4)', () => {
  it('answers ping with pong (serverTime epoch ms) and acks viewport.set / presence.update with the same ref', async () => {
    const client = await connectUser(testApp, alice);
    const pong = await client.request('ping', { t: 1_790_000_000_000 });
    expect(pong.type).toBe('pong');
    expect(pong.data['t']).toBe(1_790_000_000_000);
    expect(typeof pong.data['serverTime']).toBe('number');
    expect((await client.request('viewport.set', { bbox: TEL_AVIV_VIEWPORT, zoom: 15 })).type).toBe('ack');
    expect((await client.request('presence.update', { status: 'idle' })).type).toBe('ack');
    await client.close();
  });

  it('rejects unknown types, extra keys and malformed JSON with typed errors', async () => {
    const client = await connectUser(testApp, alice);
    const unknown = await client.request('area.delete', { areaId: newId() });
    expect(unknown).toMatchObject({ type: 'error', data: { code: 'UNKNOWN_MESSAGE_TYPE' } });
    const extra = await client.request('ping', { t: 1, extra: true });
    expect(extra).toMatchObject({ type: 'error', data: { code: 'VALIDATION_FAILED' } });
    client.send('{not json');
    await client.waitFor((message) => message.type === 'error' && message.data['code'] === 'MALFORMED_JSON');
    expect(client.closeCode).toBeNull();
    await client.close();
  });

  it('throttles an empty bucket: THROTTLED for commands, silent drops for ephemeral types', async () => {
    const client = await connectUser(testApp, alice);
    for (let i = 0; i < 60; i += 1) client.send({ type: 'presence.update', data: { status: 'viewing' } });
    client.send({ type: 'ping', ref: 'late-ping', data: { t: 1 } });
    const reply = await client.waitFor((message) => message.ref === 'late-ping');
    expect(reply).toMatchObject({ type: 'error', data: { code: 'THROTTLED' } });
    expect(client.ofType('error').filter((message) => message.data['code'] === 'THROTTLED')).toHaveLength(1);
    await client.close();
  });

  it('does not upgrade (and consumes no ticket) for a plain GET /ws', async () => {
    const ticket = await issueTicket(testApp.container, alice, alice.sessionId);
    const response = await testApp.app.inject({ method: 'GET', url: `/ws?ticket=${ticket}` });
    expect(response.statusCode).toBe(404);
    const client = await openClient(testApp, ticket);
    await client.waitFor((message) => message.type === 'welcome');
    await client.close();
  });
});

describe('GET /api/v1/presence (section 6.4)', () => {
  it('lists the online connections for REST-only clients', async () => {
    const client = await connectUser(testApp, bob, { viewport: TEL_AVIV_VIEWPORT });
    const connectionId = String(client.ofType('welcome')[0]?.data['connectionId']);
    const body = await waitFor(async () => {
      const response = await testApp.app.inject({
        method: 'GET',
        url: '/api/v1/presence',
        headers: bearer(alice),
      });
      expect(response.statusCode).toBe(200);
      const parsed = PresenceListResponseSchema.parse(response.json());
      return parsed.items.some((item) => item.connectionId === connectionId) ? parsed : null;
    });
    expect(body.onlineCount).toBeGreaterThanOrEqual(1);
    expect(body.items.length).toBeLessThanOrEqual(500);
    await client.close();
  });

  it('returns at most 500 items (most recent first) with truncated and the distinct-user count', async () => {
    const redis = testApp.container.redis.cmd;
    const key = testApp.container.keys.presenceConns();
    const seen = testApp.container.keys.presenceSeen();
    const fakeIds = Array.from({ length: 520 }, () => newId());
    const now = Date.now();
    const pipeline = redis.pipeline();
    fakeIds.forEach((connectionId, index) => {
      pipeline.hset(key, connectionId, fakePresenceEntry(connectionId, alice, now + index));
      // Seen "in the future", so the sweeper leaves them alone during this test.
      pipeline.zadd(seen, now + 60_000, connectionId);
    });
    await pipeline.exec();
    try {
      const response = await testApp.app.inject({
        method: 'GET',
        url: '/api/v1/presence',
        headers: bearer(bob),
      });
      const body = PresenceListResponseSchema.parse(response.json());
      expect(body.items).toHaveLength(500);
      expect(body.truncated).toBe(true);
      expect(body.items[0]?.connectionId).toBe(fakeIds.at(-1));
      expect(body.onlineCount).toBeGreaterThanOrEqual(1);
    } finally {
      await redis.hdel(key, ...fakeIds);
      await redis.zrem(seen, ...fakeIds);
    }
  });

  it('requires authentication', async () => {
    const response = await testApp.app.inject({ method: 'GET', url: '/api/v1/presence' });
    expect(response.statusCode).toBe(401);
  });
});

describe('audit trail (section 10.4)', () => {
  it('records ws.connect and ws.disconnect with per-type counts (draftTouches included)', async () => {
    const client = await connectUser(testApp, bob, { viewport: TEL_AVIV_VIEWPORT });
    const connectionId = String(client.ofType('welcome')[0]?.data['connectionId']);
    const draftId = newId();
    expect((await client.request('draft.start', { draftId, areaId: null, resume: false })).type).toBe('ack');
    client.send({ type: 'draft.touch', data: { draftId } });
    client.send({
      type: 'draft.update',
      data: { draftId, rev: 1, vertices: [[34.78, 32.08]], cursor: null },
    });
    expect((await client.request('ping', { t: 1 })).type).toBe('pong');
    await client.close();
    const disconnect = await waitFor(
      () => audit.find((event) => event.action === 'ws.disconnect' && event.targetId === connectionId)[0],
    );
    expect(
      audit.find((event) => event.action === 'ws.connect' && event.targetId === connectionId),
    ).toHaveLength(1);
    expect(disconnect).toMatchObject({
      outcome: 'success',
      actorId: bob.id,
      sessionId: bob.sessionId,
      targetType: 'ws_connection',
      details: {
        instanceId: testApp.container.instanceId,
        code: 1000,
        counts: { viewportSets: 1, draftUpdates: 1, draftTouches: 1, pings: 1, invalid: 0 },
      },
    });
    expect(Number(disconnect.details['messagesIn'])).toBeGreaterThanOrEqual(5);
    expect(Number(disconnect.details['durationMs'])).toBeGreaterThanOrEqual(0);
  });
});

describe('WS_PERMESSAGE_DEFLATE knob (section 7.8)', () => {
  it('negotiates no compression by default and permessage-deflate when the knob is on', async () => {
    const plain = await connectUser(testApp, alice);
    // The Node client offers permessage-deflate; the server only accepts it when configured to.
    expect(plain.socket.extensions).toBe('');
    await plain.close();

    const deflating = await createTestApp({ config: { ...FAST_REALTIME, WS_PERMESSAGE_DEFLATE: true } });
    try {
      const user = await createUser(deflating.container);
      const compressed = await connectUser(deflating, user);
      expect(compressed.socket.extensions).toContain('permessage-deflate');
      expect((await compressed.request('ping', { t: 2 })).type).toBe('pong');
      await compressed.close();
    } finally {
      await deflating.close();
    }
  });
});

describe('graceful stop (section 10.12)', () => {
  it('closes sockets with 1001 and removes this instance’s presence entries and locks', async () => {
    const stopping = await createTestApp({ config: FAST_REALTIME });
    const carol = await createUser(stopping.container, { displayName: 'Carol' });
    const areaId = await insertArea(stopping.container, carol.id);
    const client = await connectUser(stopping, carol, { viewport: TEL_AVIV_VIEWPORT });
    const connectionId = String(client.ofType('welcome')[0]?.data['connectionId']);
    expect((await client.request('lock.acquire', { areaId, scope: 'geometry' })).type).toBe('lock.acquired');
    const keys = stopping.container.keys;
    const inspector = new Redis(testApp.config.REDIS_URL, { maxRetriesPerRequest: 1 });
    try {
      await waitFor(async () => (await inspector.hexists(keys.presenceConns(), connectionId)) === 1);
      await stopping.close();
      expect((await client.closed).code).toBe(1001);
      expect(await inspector.hexists(keys.presenceConns(), connectionId)).toBe(0);
      expect(await inspector.zscore(keys.presenceSeen(), connectionId)).toBeNull();
      expect(await inspector.hexists(keys.locks(), areaId)).toBe(0);
    } finally {
      inspector.disconnect();
    }
  });
});
