/**
 * POST /api/v1/auth/ws-ticket (SPEC section 6.2, section 7.2): a 43-character base64url ticket, single use, expiring after
 * WS_TICKET_TTL_S, whose consumed claims carry the CURRENT profile (displayName, color, role) and the session's absolute
 * expiry; 503 SERVICE_UNAVAILABLE (audited once) while Redis is down.
 */
import { WsTicketResponseSchema } from '@snapland/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { hashTicket } from '../../../src/infra/auth/ws-tickets.js';
import { createTcpProxy } from '../../helpers/tcp-proxy.js';
import { revokeSessionInDb } from '../../helpers/users.js';
import { waitFor } from '../../helpers/wait-for.js';
import {
  auditEventsOf,
  authed,
  createAuthTestApp,
  problem,
  registerUser,
  sessionRow,
  setRole,
} from './auth-test-kit.js';
import type { AuthTestApp } from './auth-test-kit.js';

const TICKET_TTL_S = 5;
let testApp: AuthTestApp;

beforeAll(async () => {
  testApp = await createAuthTestApp({ config: { WS_TICKET_TTL_S: TICKET_TTL_S } });
});

afterAll(async () => {
  await testApp.close();
});

function requestTicket(app: AuthTestApp, accessToken: string) {
  return authed(app, 'POST', '/api/v1/auth/ws-ticket', accessToken);
}

describe('POST /api/v1/auth/ws-ticket', () => {
  it('issues a 43-char single-use ticket whose claims carry the profile, role and absolute expiry', async () => {
    const user = await registerUser(testApp, { displayName: 'Ticket Holder' });
    const response = await requestTicket(testApp, user.auth.accessToken);
    expect(response.statusCode).toBe(201);
    expect(response.headers['cache-control']).toBe('no-store');
    const { ticket, expiresAt } = WsTicketResponseSchema.parse(response.json());
    expect(ticket).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const lifetimeMs = new Date(expiresAt).getTime() - Date.now();
    expect(lifetimeMs).toBeGreaterThan(0);
    expect(lifetimeMs).toBeLessThanOrEqual(TICKET_TTL_S * 1000);

    const session = await sessionRow(testApp, user.auth.sessionId);
    await expect(testApp.container.wsTickets.consume(ticket)).resolves.toEqual({
      userId: user.auth.user.id,
      sessionId: user.auth.sessionId,
      displayName: 'Ticket Holder',
      color: user.auth.user.color,
      role: 'user',
      absoluteExpiresAt: session.absolute_expires_at.toISOString(),
    });
    await expect(testApp.container.wsTickets.consume(ticket)).resolves.toBeNull();

    expect(auditEventsOf(testApp, response)).toEqual([
      expect.objectContaining({
        action: 'auth.ws_ticket',
        outcome: 'success',
        actorId: user.auth.user.id,
        sessionId: user.auth.sessionId,
        targetType: 'session',
        targetId: user.auth.sessionId,
      }),
    ]);
    expect(JSON.stringify(auditEventsOf(testApp, response))).not.toContain(ticket);
  });

  it('is stored with a TTL of WS_TICKET_TTL_S', async () => {
    const user = await registerUser(testApp);
    const { ticket } = WsTicketResponseSchema.parse(
      (await requestTicket(testApp, user.auth.accessToken)).json(),
    );
    const key = testApp.container.keys.wsTicket(hashTicket(ticket));
    const ttlMs = await testApp.container.redis.cmd.pttl(key);
    expect(ttlMs).toBeGreaterThan(0);
    expect(ttlMs).toBeLessThanOrEqual(TICKET_TTL_S * 1000);
  });

  it('carries the current role from the database, not the role inside the access token', async () => {
    const user = await registerUser(testApp);
    await setRole(testApp, user.auth.user.id, 'admin');
    const { ticket } = WsTicketResponseSchema.parse(
      (await requestTicket(testApp, user.auth.accessToken)).json(),
    );
    await expect(testApp.container.wsTickets.consume(ticket)).resolves.toMatchObject({ role: 'admin' });
  });

  it('refuses a session revoked in the database (401 SESSION_REVOKED) and a request without a token', async () => {
    const user = await registerUser(testApp);
    await revokeSessionInDb(testApp.container, user.auth.sessionId, 'admin');
    const revoked = await requestTicket(testApp, user.auth.accessToken);
    expect(revoked.statusCode).toBe(401);
    expect(problem(revoked).code).toBe('SESSION_REVOKED');

    const anonymous = await testApp.app.inject({ method: 'POST', url: '/api/v1/auth/ws-ticket' });
    expect(anonymous.statusCode).toBe(401);
    expect(auditEventsOf(testApp, anonymous)).toEqual([]);
  });

  it('answers 503 SERVICE_UNAVAILABLE while Redis is down, audited once as a failure', async () => {
    const proxy = await createTcpProxy(process.env['REDIS_URL'] ?? '');
    const degraded = await createAuthTestApp({ config: { REDIS_URL: proxy.url } });
    try {
      const user = await registerUser(degraded);
      proxy.pause();
      await waitFor(() => degraded.container.redis.cmd.status !== 'ready');

      const response = await requestTicket(degraded, user.auth.accessToken);
      expect(response.statusCode).toBe(503);
      expect(problem(response).code).toBe('SERVICE_UNAVAILABLE');
      expect(Number(response.headers['retry-after'])).toBeGreaterThan(0);
      expect(auditEventsOf(degraded, response)).toEqual([
        expect.objectContaining({
          action: 'auth.ws_ticket',
          outcome: 'failure',
          actorId: user.auth.user.id,
          details: { code: 'SERVICE_UNAVAILABLE', status: 503 },
        }),
      ]);
    } finally {
      await degraded.close();
      await proxy.close();
    }
  });
});
