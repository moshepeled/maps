import { ProblemSchema } from '@snapland/shared';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { hashTicket } from '../../../src/infra/auth/ws-tickets.js';
import type { WsTicketClaims } from '../../../src/infra/auth/ws-tickets.js';
import { createTcpProxy } from '../../helpers/tcp-proxy.js';
import type { TcpProxy } from '../../helpers/tcp-proxy.js';
import { createTestApp } from '../../helpers/test-app.js';
import type { TestApp } from '../../helpers/test-app.js';
import { bearer, createUser } from '../../helpers/users.js';
import { waitFor } from '../../helpers/wait-for.js';

let testApp: TestApp;
const extraApps: TestApp[] = [];
const proxies: TcpProxy[] = [];

beforeAll(async () => {
  testApp = await createTestApp({
    routes: (scope) => {
      scope.get('/whoami', { onRequest: [scope.authenticate] }, (request) => request.auth);
    },
  });
});

afterAll(async () => {
  await testApp.close();
});

afterEach(async () => {
  await Promise.all(extraApps.splice(0).map((app) => app.close()));
  await Promise.all(proxies.splice(0).map((proxy) => proxy.close()));
});

const CLAIMS: WsTicketClaims = {
  userId: '3f6c1a2e-0b1d-4c55-9a0e-7c1d2b3a4f50',
  sessionId: '9b2d7c4e-5a61-4f3b-8e2a-1c0d9f8e7a61',
  displayName: 'Alice',
  color: '#c44f9d',
  role: 'user',
  absoluteExpiresAt: '2026-10-27T10:00:00.000Z',
};

describe('WebSocket tickets (section 6.2, section 7.2)', () => {
  it('issues a 43-char ticket stored only as its SHA-256, with the configured TTL, consumable exactly once', async () => {
    const { container } = testApp;
    const { ticket, expiresAt } = await container.wsTickets.issue(CLAIMS);
    expect(ticket).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(expiresAt.getTime()).toBeGreaterThan(Date.now());
    const key = container.keys.wsTicket(hashTicket(ticket));
    const ttl = await container.redis.cmd.ttl(key);
    expect(ttl).toBeGreaterThan(0);
    expect(ttl).toBeLessThanOrEqual(container.config.WS_TICKET_TTL_S);
    const raw = await container.redis.cmd.keys(`${container.keys.prefix}wsticket:*`);
    expect(raw.some((stored) => stored.includes(ticket))).toBe(false);

    await expect(container.wsTickets.consume(ticket)).resolves.toEqual(CLAIMS);
    await expect(container.wsTickets.consume(ticket)).resolves.toBeNull();
  });

  it('answers null for unknown, malformed or corrupted tickets', async () => {
    const { container } = testApp;
    await expect(container.wsTickets.consume('x'.repeat(43))).resolves.toBeNull();
    await expect(container.wsTickets.consume('../../etc/passwd')).resolves.toBeNull();
    const forged = 'f'.repeat(43);
    await container.redis.cmd.set(container.keys.wsTicket(hashTicket(forged)), '{"userId":"nope"}', 'EX', 30);
    await expect(container.wsTickets.consume(forged)).resolves.toBeNull();
  });
});

describe('session revocation store (section 6.2)', () => {
  it('marks a session revoked for ACCESS_TOKEN_TTL_S and reports it', async () => {
    const { container } = testApp;
    const sessionId = '0d6b1f3e-2c4a-4e8b-9f1a-3b5c7d9e1f20';
    await expect(container.revocations.isRevoked(sessionId)).resolves.toBe(false);
    await container.revocations.markRevoked(sessionId);
    await expect(container.revocations.isRevoked(sessionId)).resolves.toBe(true);
    const ttl = await container.redis.cmd.ttl(container.keys.revokedSession(sessionId));
    expect(ttl).toBeGreaterThan(container.config.ACCESS_TOKEN_TTL_S - 5);
  });

  it('isRevoked fails open and markRevoked throws while Redis is unreachable', async () => {
    const proxy = await createTcpProxy(process.env['REDIS_URL'] ?? '');
    proxies.push(proxy);
    const broken = await createTestApp({ config: { REDIS_URL: proxy.url } });
    extraApps.push(broken);
    proxy.pause();
    await waitFor(() => broken.container.redis.cmd.status !== 'ready');
    await expect(
      broken.container.revocations.isRevoked('0d6b1f3e-2c4a-4e8b-9f1a-3b5c7d9e1f20'),
    ).resolves.toBe(false);
    await expect(
      broken.container.revocations.markRevoked('0d6b1f3e-2c4a-4e8b-9f1a-3b5c7d9e1f20'),
    ).rejects.toThrow();
  });
});

describe('app.authenticate (section 3.3)', () => {
  it('accepts a valid Bearer token and exposes request.auth', async () => {
    const user = await createUser(testApp.container);
    const response = await testApp.app.inject({
      method: 'GET',
      url: '/__test/whoami',
      headers: bearer(user),
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual(user.claims);
  });

  it('answers UNAUTHENTICATED, TOKEN_INVALID and SESSION_REVOKED with 401 problems', async () => {
    const user = await createUser(testApp.container);
    const codeOf = async (headers: Record<string, string>): Promise<string> => {
      const response = await testApp.app.inject({ method: 'GET', url: '/__test/whoami', headers });
      expect(response.statusCode).toBe(401);
      return ProblemSchema.parse(response.json()).code;
    };
    expect(await codeOf({})).toBe('UNAUTHENTICATED');
    expect(await codeOf({ authorization: 'Basic abc' })).toBe('UNAUTHENTICATED');
    expect(await codeOf({ authorization: `Bearer ${user.accessToken.slice(0, -2)}xx` })).toBe(
      'TOKEN_INVALID',
    );
    await testApp.container.revocations.markRevoked(user.sessionId);
    expect(await codeOf(bearer(user))).toBe('SESSION_REVOKED');
  });
});
