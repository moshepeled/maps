import { afterEach, describe, expect, it } from 'vitest';

import type { BusEnvelope, BusPayload } from '../../../src/infra/events/types.js';
import { connectionName } from '../../../src/infra/redis/client.js';
import { createRedisAdmin } from '../../helpers/redis-admin.js';
import { createTcpProxy } from '../../helpers/tcp-proxy.js';
import type { TcpProxy } from '../../helpers/tcp-proxy.js';
import { createTestApp } from '../../helpers/test-app.js';
import type { TestApp } from '../../helpers/test-app.js';
import { waitFor } from '../../helpers/wait-for.js';

const apps: TestApp[] = [];
const proxies: TcpProxy[] = [];

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
  await Promise.all(proxies.splice(0).map((proxy) => proxy.close()));
});

async function app(options: Parameters<typeof createTestApp>[0] = {}): Promise<TestApp> {
  const created = await createTestApp(options);
  apps.push(created);
  return created;
}

const SESSION_EVENT: BusPayload<'sessions'> = {
  kind: 'revoked',
  sessionId: '9b2d7c4e-5a61-4f3b-8e2a-1c0d9f8e7a61',
  userId: '3f6c1a2e-0b1d-4c55-9a0e-7c1d2b3a4f50',
  reason: 'logout',
};

describe('RedisEventBus (section 7.10)', () => {
  it('delivers locally (synchronously) and to another instance, skipping its own messages', async () => {
    const a = await app();
    const b = await app();
    const receivedOnA: BusEnvelope<BusPayload<'sessions'>>[] = [];
    const receivedOnB: BusEnvelope<BusPayload<'sessions'>>[] = [];
    a.container.events.subscribe('sessions', (message) => receivedOnA.push(message));
    b.container.events.subscribe('sessions', (message) => receivedOnB.push(message));
    // SUBSCRIBE is asynchronous: wait until both subscribers are registered on the server.
    await waitFor(async () => {
      const counts = (await a.container.redis.cmd.pubsub('NUMSUB', a.container.keys.channel('sessions'))) as [
        string,
        number,
      ];
      return counts[1] >= 2;
    });

    const published = a.container.events.publish('sessions', SESSION_EVENT);
    expect(receivedOnA).toHaveLength(1);
    expect(await published).toBe(true);

    const [remote] = await waitFor(() => (receivedOnB.length > 0 ? receivedOnB : null));
    expect(remote).toMatchObject({ v: 1, origin: a.container.instanceId, payload: SESSION_EVENT });
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(receivedOnA).toHaveLength(1);
  });

  it('drops invalid remote messages (validated payloads) and counts them', async () => {
    const a = await app();
    const received: unknown[] = [];
    a.container.events.subscribe('sessions', (message) => received.push(message));
    await waitFor(async () => {
      const counts = (await a.container.redis.cmd.pubsub('NUMSUB', a.container.keys.channel('sessions'))) as [
        string,
        number,
      ];
      return counts[1] >= 1;
    });
    const channel = a.container.keys.channel('sessions');
    await a.container.redis.cmd.publish(channel, 'not json');
    await a.container.redis.cmd.publish(
      channel,
      JSON.stringify({ v: 1, origin: 'other', ts: 1, payload: { kind: 'nope' } }),
    );
    const metrics = await waitFor(async () => {
      const body = (await a.app.inject({ method: 'GET', url: '/metrics' })).body;
      return /snapland_bus_messages_total\{[^}]*result="invalid"[^}]*\} 2/.test(body) ? body : null;
    });
    expect(metrics).toBeTruthy();
    expect(received).toEqual([]);
  });

  it('publish resolves false (and never throws) while Redis is unreachable', async () => {
    const proxy = await createTcpProxy(process.env['REDIS_URL'] ?? '');
    proxies.push(proxy);
    const a = await app({ config: { REDIS_URL: proxy.url } });
    const local: unknown[] = [];
    a.container.events.subscribe('sessions', (message) => local.push(message));
    proxy.pause();
    await waitFor(() => a.container.redis.cmd.status !== 'ready');
    await expect(a.container.events.publish('sessions', SESSION_EVENT)).resolves.toBe(false);
    expect(local).toHaveLength(1);
  });

  it('fires onReconnect after the subscriber connection is killed (and keeps receiving)', async () => {
    const a = await app();
    const b = await app();
    const received: unknown[] = [];
    let reconnects = 0;
    b.container.events.subscribe('sessions', (message) => received.push(message));
    b.container.events.onReconnect(() => {
      reconnects += 1;
    });
    await waitFor(async () => {
      const counts = (await a.container.redis.cmd.pubsub('NUMSUB', a.container.keys.channel('sessions'))) as [
        string,
        number,
      ];
      return counts[1] >= 1;
    });
    const admin = createRedisAdmin();
    try {
      expect(await admin.killClientByName(connectionName('sub', b.container.instanceId))).toBe(1);
      await expect(admin.killClientByName('snapland-sub-someone-else')).rejects.toThrow(/refusing/);
    } finally {
      await admin.close();
    }
    await waitFor(() => reconnects === 1, { description: 'onReconnect fired' });
    await waitFor(async () => {
      await a.container.events.publish('sessions', SESSION_EVENT);
      return received.length > 0;
    });
  });
});
