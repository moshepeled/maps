/**
 * WebSocket authentication and session enforcement (SPEC section 7.2, section 10.1 ws_upgrade, section 10.4 ws.reject, MA7):
 * every refusal happens before the 101; lost `sessions` events are repaired by the DB re-validation; the absolute
 * expiry timer and bus events close sockets with 4401 on every instance.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { hashTicket } from '../../../src/infra/auth/ws-tickets.js';
import { connectionName } from '../../../src/infra/redis/client.js';
import type { InMemoryAuditLogger } from '../../../src/infra/audit/in-memory.js';
import { createMemoryAudit } from '../../helpers/audit.js';
import { uniqueIp } from '../../helpers/net.js';
import { createRedisAdmin } from '../../helpers/redis-admin.js';
import { createTestApp } from '../../helpers/test-app.js';
import type { TestApp } from '../../helpers/test-app.js';
import { createUser, disableUserInDb, revokeSessionInDb } from '../../helpers/users.js';
import type { TestUser } from '../../helpers/users.js';
import { waitFor } from '../../helpers/wait-for.js';
import { WsHandshakeError } from '../../helpers/ws-client.js';
import { FAST_REALTIME, connectUser, handshakeStatus, issueTicket, openClient } from './realtime-harness.js';

const apps: TestApp[] = [];
let testApp: TestApp;
let audit: InMemoryAuditLogger;
let alice: TestUser;

async function track(created: Promise<TestApp>): Promise<TestApp> {
  const app = await created;
  apps.push(app);
  return app;
}

beforeAll(async () => {
  audit = createMemoryAudit();
  testApp = await track(createTestApp({ config: FAST_REALTIME, overrides: { audit } }));
  alice = await createUser(testApp.container, { displayName: 'Alice' });
});

afterAll(async () => {
  await Promise.all(apps.map((app) => app.close()));
});

async function ticketFor(app: TestApp, user: TestUser): Promise<string> {
  return issueTicket(app.container, user, user.sessionId);
}

describe('upgrade refused before 101 (section 7.2 step 3)', () => {
  it('403 for a disallowed or a missing Origin', async () => {
    expect(
      await handshakeStatus(testApp, await ticketFor(testApp, alice), { origin: 'https://evil.example' }),
    ).toBe(403);
    expect(await handshakeStatus(testApp, await ticketFor(testApp, alice), { origin: null })).toBe(403);
  });

  it('400 without the snapland.v1 subprotocol', async () => {
    expect(await handshakeStatus(testApp, await ticketFor(testApp, alice), { protocols: [] })).toBe(400);
    expect(await handshakeStatus(testApp, await ticketFor(testApp, alice), { protocols: ['other.v1'] })).toBe(
      400,
    );
  });

  it('401 for a missing, unknown, reused or expired ticket', async () => {
    expect(await handshakeStatus(testApp, null)).toBe(401);
    expect(await handshakeStatus(testApp, 'x'.repeat(43))).toBe(401);

    const ticket = await ticketFor(testApp, alice);
    expect(await handshakeStatus(testApp, ticket)).toBe(101);
    expect(await handshakeStatus(testApp, ticket)).toBe(401);

    const expiring = await ticketFor(testApp, alice);
    // Let Redis expire it exactly as the 30 s TTL would.
    await testApp.container.redis.cmd.pexpire(testApp.container.keys.wsTicket(hashTicket(expiring)), 1);
    await waitFor(
      async () =>
        (await testApp.container.redis.cmd.exists(testApp.container.keys.wsTicket(hashTicket(expiring)))) ===
        0,
    );
    expect(await handshakeStatus(testApp, expiring)).toBe(401);
  });

  it('401 for a revoked session (DB or revocation marker) and for a disabled user', async () => {
    const revoked = await createUser(testApp.container);
    const ticket = await ticketFor(testApp, revoked);
    await revokeSessionInDb(testApp.container, revoked.sessionId);
    expect(await handshakeStatus(testApp, ticket)).toBe(401);

    const marked = await createUser(testApp.container);
    const markedTicket = await ticketFor(testApp, marked);
    await testApp.container.revocations.markRevoked(marked.sessionId);
    expect(await handshakeStatus(testApp, markedTicket)).toBe(401);

    const disabled = await createUser(testApp.container);
    const disabledTicket = await ticketFor(testApp, disabled);
    await disableUserInDb(testApp.container, disabled.id);
    expect(await handshakeStatus(testApp, disabledTicket)).toBe(401);
  });

  it('capacity: 429 beyond the per-user cap, 503 beyond the per-instance cap', async () => {
    const capped = await track(
      createTestApp({
        config: { ...FAST_REALTIME, WS_MAX_CONNECTIONS_PER_USER: 1, WS_MAX_CONNECTIONS_PER_INSTANCE: 2 },
      }),
    );
    const [u1, u2, u3] = await Promise.all([
      createUser(capped.container),
      createUser(capped.container),
      createUser(capped.container),
    ]);
    const first = await connectUser(capped, u1);
    expect(await handshakeStatus(capped, await ticketFor(capped, u1))).toBe(429);
    const second = await connectUser(capped, u2);
    expect(await handshakeStatus(capped, await ticketFor(capped, u3))).toBe(503);
    await first.close();
    await waitFor(async () => (await handshakeStatus(capped, await ticketFor(capped, u3))) === 101);
    await second.close();
  });

  it('ws_upgrade limit: the 4th upgrade from one address is 429 and its ticket stays usable', async () => {
    const limited = await track(
      createTestApp({ config: { ...FAST_REALTIME, WS_UPGRADE_RATE_LIMIT_MAX: 3 } }),
    );
    const user = await createUser(limited.container);
    const ip = uniqueIp();
    for (let i = 0; i < 3; i += 1) {
      expect(await handshakeStatus(limited, await ticketFor(limited, user), { ip })).toBe(101);
    }
    const ticket = await ticketFor(limited, user);
    const rejected = await openClient(limited, ticket, { ip }).then(
      () => null,
      (error: unknown) => error,
    );
    expect(rejected).toBeInstanceOf(WsHandshakeError);
    expect((rejected as WsHandshakeError).statusCode).toBe(429);
    expect(JSON.parse((rejected as WsHandshakeError).body)).toMatchObject({
      code: 'RATE_LIMITED',
      scope: 'ws_upgrade',
    });
    // onRequest ran before preValidation: the ticket was not consumed.
    expect(await handshakeStatus(limited, ticket, { ip: uniqueIp() })).toBe(101);
  });

  it('counts rejections by result and audits them as coalesced ws.reject rows (100 -> count sum 100)', async () => {
    const ip = uniqueIp();
    for (let batch = 0; batch < 10; batch += 1) {
      const statuses = await Promise.all(
        Array.from({ length: 10 }, () =>
          handshakeStatus(testApp, 'x'.repeat(43), { ip, origin: 'https://evil.example' }),
        ),
      );
      expect(statuses.every((status) => status === 403)).toBe(true);
    }
    await testApp.container.auditCoalescer.flush();
    const rows = audit.find((event) => event.action === 'ws.reject' && event.ip === ip);
    expect(rows.length).toBeLessThanOrEqual(2);
    expect(rows.reduce((sum, row) => sum + Number(row.details['count']), 0)).toBe(100);
    expect(rows[0]).toMatchObject({ outcome: 'denied', details: { reason: 'origin' } });
    const metrics = (await testApp.app.inject({ method: 'GET', url: '/metrics' })).body;
    expect(metrics).toMatch(/snapland_ws_connections_total\{[^}]*result="rejected_origin"[^}]*\} \d+/);
  });
});

describe('session re-validation (section 7.2 step 5)', () => {
  it('closes a socket whose session was revoked in the DB WITHOUT a bus event within 500 ms + 500 ms', async () => {
    const user = await createUser(testApp.container);
    const client = await connectUser(testApp, user);
    const revokedAt = Date.now();
    await revokeSessionInDb(testApp.container, user.sessionId);
    const { code } = await client.closed;
    expect(code).toBe(4401);
    expect(Date.now() - revokedAt).toBeLessThanOrEqual(1000);
    const metrics = (await testApp.app.inject({ method: 'GET', url: '/metrics' })).body;
    expect(metrics).toMatch(/snapland_ws_revalidation_closes_total\{[^}]*\} [1-9]/);
    expect(metrics).toMatch(/snapland_ws_revalidation_runs_total\{[^}]*result="ok"[^}]*\} [1-9]/);
    await testApp.container.auditCoalescer.flush();
    expect(
      audit.find(
        (event) =>
          event.action === 'ws.reject' &&
          event.details['reason'] === 'revalidation' &&
          event.actorId === user.id,
      ),
    ).not.toHaveLength(0);
  });

  it('closes the sockets of a user disabled in the DB', async () => {
    const user = await createUser(testApp.container);
    const client = await connectUser(testApp, user);
    await disableUserInDb(testApp.container, user.id);
    expect((await client.closed).code).toBe(4401);
  });

  it('re-validates immediately after the bus subscriber reconnects (CLIENT KILL of this run’s subscriber)', async () => {
    const slow = await track(
      createTestApp({ config: { ...FAST_REALTIME, REALTIME_SESSION_REVALIDATE_MS: 600_000 } }),
    );
    const [revoked, bystander] = await Promise.all([createUser(slow.container), createUser(slow.container)]);
    const doomed = await connectUser(slow, revoked);
    const survivor = await connectUser(slow, bystander);
    await revokeSessionInDb(slow.container, revoked.sessionId);
    const admin = createRedisAdmin();
    try {
      const killedAt = Date.now();
      expect(await admin.killClientByName(connectionName('sub', slow.container.instanceId))).toBeGreaterThan(
        0,
      );
      expect((await doomed.closed).code).toBe(4401);
      expect(Date.now() - killedAt).toBeLessThan(5000);
      const resync = await survivor.waitFor((message) => message.type === 'resync.required');
      expect(resync.data).toMatchObject({ reason: 'bus_reconnected' });
      expect(typeof resync.data['latestChangeSeq']).toBe('number');
      expect(survivor.closeCode).toBeNull();
    } finally {
      await admin.close();
      await survivor.close();
    }
  });
});

describe('absolute expiry and bus events (section 7.2 step 5)', () => {
  it('closes with 4401 when the session reaches its absolute expiry (SESSION_ABSOLUTE_TTL_S=3)', async () => {
    const shortLived = await track(
      createTestApp({
        config: {
          ...FAST_REALTIME,
          SESSION_ABSOLUTE_TTL_S: 3,
          REFRESH_TOKEN_TTL_S: 3,
          REALTIME_SESSION_REVALIDATE_MS: 600_000,
        },
      }),
    );
    const user = await createUser(shortLived.container);
    const connectedAt = Date.now();
    const client = await connectUser(shortLived, user);
    const { code, reason } = await client.closed;
    const elapsed = Date.now() - connectedAt;
    expect(code).toBe(4401);
    expect(reason).toBe('session expired');
    expect(elapsed).toBeGreaterThan(1500);
    expect(elapsed).toBeLessThan(4500);
  });

  it('a sessions bus event published on instance A closes the session’s sockets on A and B', async () => {
    const other = await track(
      createTestApp({ config: { ...FAST_REALTIME, REALTIME_SESSION_REVALIDATE_MS: 600_000 } }),
    );
    const user = await createUser(testApp.container);
    const onA = await connectUser(testApp, user);
    const onB = await connectUser(other, user);
    const bystander = await connectUser(other, alice);
    await testApp.container.events.publish('sessions', {
      kind: 'revoked',
      sessionId: user.sessionId,
      userId: user.id,
      reason: 'logout',
    });
    expect((await onA.closed).code).toBe(4401);
    expect((await onB.closed).code).toBe(4401);
    expect(bystander.closeCode).toBeNull();
    await bystander.close();
  });
});
