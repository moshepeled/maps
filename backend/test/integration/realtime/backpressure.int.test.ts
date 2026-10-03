/**
 * Backpressure and protocol limits (SPEC section 7.8, section 7.11, section 10.11): 4429 on floods, 1003 on binary frames, 1009 on
 * oversize frames, heartbeat termination, 1013 for a slow consumer, and resync.required after the bus subscriber
 * reconnects.
 */
import type { Bbox } from '@snapland/shared';
import { pino } from 'pino';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { systemClock } from '../../../src/infra/clock.js';
import { InMemoryEventBus } from '../../../src/infra/events/in-memory.js';
import { connectionName } from '../../../src/infra/redis/client.js';
import { createRedisAdmin } from '../../helpers/redis-admin.js';
import { createTestApp } from '../../helpers/test-app.js';
import type { TestApp } from '../../helpers/test-app.js';
import { createUser } from '../../helpers/users.js';
import type { TestUser } from '../../helpers/users.js';
import { waitFor } from '../../helpers/wait-for.js';
import {
  FAST_REALTIME,
  TEL_AVIV_VIEWPORT,
  areaChangedPayload,
  connectUser,
  delay,
} from './realtime-harness.js';

let testApp: TestApp;
let alice: TestUser;

beforeAll(async () => {
  testApp = await createTestApp({ config: FAST_REALTIME });
  alice = await createUser(testApp.container, { displayName: 'Alice' });
});

afterAll(async () => {
  await testApp.close();
});

describe('inbound limits (section 7.8)', () => {
  it('closes with 4429 after more than 200 throttled messages within 10 s', async () => {
    const client = await connectUser(testApp, alice);
    for (let i = 0; i < 300; i += 1) client.send({ type: 'presence.update', data: { status: 'viewing' } });
    expect((await client.closed).code).toBe(4429);
  });

  it('closes with 1003 on a binary frame', async () => {
    const client = await connectUser(testApp, alice);
    client.socket.send(Buffer.from([1, 2, 3]), { binary: true });
    expect((await client.closed).code).toBe(1003);
  });

  it('closes with 1009 on a frame larger than WS_MAX_PAYLOAD_BYTES', async () => {
    const client = await connectUser(testApp, alice);
    client.send(JSON.stringify({ type: 'ping', data: { t: 1 }, pad: 'x'.repeat(70 * 1024) }));
    expect((await client.closed).code).toBe(1009);
  });

  it('closes with 4400 after more than 20 invalid messages within 60 s', async () => {
    const client = await connectUser(testApp, alice);
    for (let i = 0; i < 21; i += 1) client.send('{"type":');
    expect((await client.closed).code).toBe(4400);
    expect(
      client.ofType('error').filter((message) => message.data['code'] === 'MALFORMED_JSON'),
    ).toHaveLength(21);
  });
});

describe('heartbeat (section 7.11)', () => {
  it('terminates a connection that does not answer protocol pings, keeps one that does', async () => {
    const beating = await createTestApp({ config: { ...FAST_REALTIME, WS_PING_INTERVAL_MS: 200 } });
    try {
      const user = await createUser(beating.container);
      const silent = await connectUser(beating, user, { autoPong: false });
      const healthy = await connectUser(beating, user);
      const started = Date.now();
      expect((await silent.closed).code).toBe(1006);
      expect(Date.now() - started).toBeLessThan(2000);
      await delay(600);
      expect(healthy.closeCode).toBeNull();
      await healthy.close();
    } finally {
      await beating.close();
    }
  });
});

describe('slow consumers (section 7.8)', () => {
  it('closes a consumer that stops reading with 1013 (the critical lane is never dropped silently)', async () => {
    const bus = new InMemoryEventBus({
      instanceId: 'backpressure-bus',
      clock: systemClock,
      logger: pino({ level: 'silent' }),
    });
    const slowApp = await createTestApp({
      config: {
        ...FAST_REALTIME,
        WS_SEND_HIGH_WATER_BYTES: 1024,
        WS_SLOW_CONSUMER_TIMEOUT_MS: 200,
        WS_OUTBOUND_MAX_MESSAGES: 5,
      },
      overrides: { events: bus },
    });
    try {
      const user = await createUser(slowApp.container);
      const client = await connectUser(slowApp, user, { viewport: TEL_AVIV_VIEWPORT });
      const bbox: Bbox = [34.78, 32.08, 34.79, 32.09];
      const payload = areaChangedPayload(user, bbox, 1);
      // ~48 KB per area.changed: a realistic large polygon, so the socket buffers fill quickly.
      payload.area.geometry.coordinates = [
        [
          ...Array.from({ length: 1999 }, (_, i): [number, number] => [
            34.78 + (i % 100) * 0.0001,
            32.08 + Math.floor(i / 100) * 0.0001,
          ]),
          [34.78, 32.08],
        ],
      ];
      client.socket.pause();
      const slowConsumers = async () =>
        /snapland_ws_slow_consumer_disconnects_total\{[^}]*\} [1-9]/.test(
          (await slowApp.app.inject({ method: 'GET', url: '/metrics' })).body,
        );
      for (let i = 0; i < 4000 && !(await slowConsumers()); i += 1) {
        for (let burst = 0; burst < 20; burst += 1) await bus.publish('areas', payload);
        await delay(5);
      }
      expect(await slowConsumers()).toBe(true);
      client.socket.resume();
      expect((await client.closed).code).toBe(1013);
      await waitFor(async () =>
        /snapland_ws_disconnects_total\{[^}]*code="1013"[^}]*\} 1/.test(
          (await slowApp.app.inject({ method: 'GET', url: '/metrics' })).body,
        ),
      );
    } finally {
      await slowApp.close();
    }
  });
});

describe('bus reconnect (section 7.10)', () => {
  it('pushes resync.required to every local connection after the subscriber reconnects', async () => {
    const clients = await Promise.all([connectUser(testApp, alice), connectUser(testApp, alice)]);
    const admin = createRedisAdmin();
    try {
      expect(
        await admin.killClientByName(connectionName('sub', testApp.container.instanceId)),
      ).toBeGreaterThan(0);
      for (const client of clients) {
        const resync = await client.waitFor((message) => message.type === 'resync.required', 8000);
        expect(resync.data).toEqual({
          reason: 'bus_reconnected',
          latestChangeSeq: await testApp.container.areasReader.latestChangeSeq(),
        });
      }
    } finally {
      await admin.close();
      await Promise.all(clients.map((client) => client.close()));
    }
  });
});
