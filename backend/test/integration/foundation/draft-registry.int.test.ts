import { randomUUID } from 'node:crypto';

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import type { DraftOwner } from '../../../src/infra/drafts/types.js';
import { LuaScript } from '../../../src/infra/redis/lua.js';
import { createTcpProxy } from '../../helpers/tcp-proxy.js';
import type { TcpProxy } from '../../helpers/tcp-proxy.js';
import { createTestApp } from '../../helpers/test-app.js';
import type { TestApp } from '../../helpers/test-app.js';
import { waitFor } from '../../helpers/wait-for.js';

let testApp: TestApp;
const proxies: TcpProxy[] = [];
const extraApps: TestApp[] = [];

beforeAll(async () => {
  testApp = await createTestApp({ config: { REALTIME_DRAFT_RESUME_WINDOW_S: 30 } });
});

afterAll(async () => {
  await testApp.close();
});

afterEach(async () => {
  await Promise.all(extraApps.splice(0).map((app) => app.close()));
  await Promise.all(proxies.splice(0).map((proxy) => proxy.close()));
});

function owner(overrides: Partial<Omit<DraftOwner, 'state'>> = {}): Omit<DraftOwner, 'state'> {
  return {
    userId: randomUUID(),
    sessionId: randomUUID(),
    connectionId: randomUUID(),
    instanceId: 'backend-1',
    ...overrides,
  };
}

describe('RedisDraftRegistry (section 7.6, one Lua script per operation)', () => {
  it('claims with SET NX: a second claim (own or foreign) is in_use', async () => {
    const { drafts } = testApp.container;
    const draftId = randomUUID();
    const alice = owner();
    await expect(drafts.claim(draftId, alice)).resolves.toBe('claimed');
    await expect(drafts.claim(draftId, alice)).resolves.toBe('in_use');
    await expect(drafts.claim(draftId, owner())).resolves.toBe('in_use');
    await expect(drafts.getOwner(draftId)).resolves.toEqual({ ...alice, state: 'active' });
    const ttl = await testApp.container.redis.cmd.ttl(testApp.container.keys.draft(draftId));
    expect(ttl).toBeGreaterThan(0);
    expect(ttl).toBeLessThanOrEqual(30);
  });

  it('resumes for the same user + session, never for another user or an active record of another session', async () => {
    const { drafts } = testApp.container;
    const draftId = randomUUID();
    const alice = owner();
    await drafts.claim(draftId, alice);
    await expect(drafts.resume(draftId, owner())).resolves.toBe('not_found');
    await expect(
      drafts.resume(draftId, { ...alice, sessionId: randomUUID(), connectionId: randomUUID() }),
    ).resolves.toBe('not_found');
    const sameSession = { ...alice, connectionId: randomUUID(), instanceId: 'backend-2' };
    await expect(drafts.resume(draftId, sameSession)).resolves.toBe('resumed');
    await expect(drafts.getOwner(draftId)).resolves.toEqual({ ...sameSession, state: 'active' });
    await expect(drafts.resume(randomUUID(), alice)).resolves.toBe('not_found');
  });

  it('resumes a disconnected record from a NEW session of the same user (re-login, UX F-11)', async () => {
    const { drafts } = testApp.container;
    const draftId = randomUUID();
    const alice = owner();
    await drafts.claim(draftId, alice);
    await expect(drafts.markDisconnected(draftId, alice.connectionId)).resolves.toBe(true);
    await expect(drafts.getOwner(draftId)).resolves.toMatchObject({ state: 'disconnected' });
    await expect(drafts.resume(draftId, owner())).resolves.toBe('not_found');
    const newSession = { ...alice, sessionId: randomUUID(), connectionId: randomUUID() };
    await expect(drafts.resume(draftId, newSession)).resolves.toBe('resumed');
    await expect(drafts.getOwner(draftId)).resolves.toEqual({ ...newSession, state: 'active' });
  });

  it('releases and marks disconnected only by the owning connection (a late close after a takeover is a no-op)', async () => {
    const { drafts } = testApp.container;
    const draftId = randomUUID();
    const alice = owner();
    await drafts.claim(draftId, alice);
    const takeover = { ...alice, connectionId: randomUUID() };
    await drafts.resume(draftId, takeover);
    await expect(drafts.markDisconnected(draftId, alice.connectionId)).resolves.toBe(false);
    await expect(drafts.release(draftId, alice.connectionId)).resolves.toBe(false);
    await expect(drafts.getOwner(draftId)).resolves.toEqual({ ...takeover, state: 'active' });
    await expect(drafts.release(draftId, takeover.connectionId)).resolves.toBe(true);
    await expect(drafts.getOwner(draftId)).resolves.toBeNull();
    await expect(drafts.resume(draftId, takeover)).resolves.toBe('not_found');
  });

  it('touch refreshes the TTL of an owned draft only', async () => {
    const { drafts, redis, keys } = testApp.container;
    const draftId = randomUUID();
    const alice = owner();
    await drafts.claim(draftId, alice);
    await redis.cmd.expire(keys.draft(draftId), 5);
    await drafts.touch(draftId, randomUUID());
    expect(await redis.cmd.ttl(keys.draft(draftId))).toBeLessThanOrEqual(5);
    await drafts.touch(draftId, alice.connectionId);
    expect(await redis.cmd.ttl(keys.draft(draftId))).toBeGreaterThan(5);
  });

  it('fails open: getOwner is null and claim/resume throw while Redis is unreachable', async () => {
    const proxy = await createTcpProxy(process.env['REDIS_URL'] ?? '');
    proxies.push(proxy);
    const broken = await createTestApp({ config: { REDIS_URL: proxy.url } });
    extraApps.push(broken);
    const draftId = randomUUID();
    await broken.container.drafts.claim(draftId, owner());
    proxy.pause();
    await waitFor(() => broken.container.redis.cmd.status !== 'ready');
    await expect(broken.container.drafts.getOwner(draftId)).resolves.toBeNull();
    await expect(broken.container.drafts.claim(randomUUID(), owner())).rejects.toThrow();
    await expect(broken.container.drafts.resume(draftId, owner())).rejects.toThrow();
    await expect(broken.container.drafts.release(draftId, randomUUID())).resolves.toBe(false);
    await expect(broken.container.drafts.markDisconnected(draftId, randomUUID())).resolves.toBe(false);
    await expect(broken.container.drafts.touch(draftId, randomUUID())).resolves.toBeUndefined();
  });

  it('falls back from EVALSHA to EVAL for a script the server does not know (fresh server, flush, failover)', async () => {
    // A source unique to this test is unknown to Redis by construction: this proves the NOSCRIPT fallback without
    // SCRIPT FLUSH, which would evict the script cache of every other run and of the running dev backend (section 12.2).
    const { redis, keys } = testApp.container;
    const script = new LuaScript(
      `-- lua-fallback probe ${randomUUID()}
redis.call('SET', KEYS[1], ARGV[1], 'PX', 60000)
return ARGV[1]`,
    );
    const key = `${keys.prefix}lua-probe:${randomUUID()}`;
    expect(await redis.cmd.call('SCRIPT', 'EXISTS', script.sha1)).toEqual([0]);

    await expect(script.run(redis.cmd, [key], ['first'])).resolves.toBe('first');

    expect(await redis.cmd.call('SCRIPT', 'EXISTS', script.sha1)).toEqual([1]);
    await expect(script.run(redis.cmd, [key], ['second'])).resolves.toBe('second');
    expect(await redis.cmd.get(key)).toBe('second');
    await redis.cmd.del(key);
  });
});
