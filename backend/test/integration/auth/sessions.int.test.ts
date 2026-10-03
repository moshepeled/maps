/**
 * Session management (SPEC section 6.1, section 6.2, section 10.4): GET /auth/sessions lists only the caller's ACTIVE sessions with
 * `current: true` on the calling one; DELETE /auth/sessions/{id} revokes an own session (Redis mark + `sessions`
 * event + `auth.session_revoke` success) and answers 404 for another user's or an unknown session (one failure row
 * `{ code: 'NOT_FOUND', status: 404 }`); GET /auth/me reflects the database state.
 */
import { SessionListResponseSchema } from '@snapland/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { uniqueIp } from '../../helpers/net.js';
import { revokeSessionInDb } from '../../helpers/users.js';
import {
  auditEventsOf,
  authed,
  createAuthTestApp,
  loginSession,
  problem,
  registerUser,
  sessionEvents,
  sessionRow,
  setSessionExpiry,
} from './auth-test-kit.js';
import type { AuthTestApp } from './auth-test-kit.js';

let testApp: AuthTestApp;

beforeAll(async () => {
  testApp = await createAuthTestApp();
});

afterAll(async () => {
  await testApp.close();
});

async function listSessions(accessToken: string) {
  const response = await authed(testApp, 'GET', '/api/v1/auth/sessions', accessToken);
  expect(response.statusCode).toBe(200);
  return { response, items: SessionListResponseSchema.parse(response.json()).items };
}

describe('GET /api/v1/auth/sessions', () => {
  it("lists only the caller's active sessions, newest first, with current: true on this one", async () => {
    const alice = await registerUser(testApp);
    const second = await loginSession(testApp, alice.username, alice.password, {
      headers: { 'user-agent': 'Second browser' },
    });
    const third = await loginSession(testApp, alice.username, alice.password);
    const expired = await loginSession(testApp, alice.username, alice.password);
    await setSessionExpiry(testApp, expired.auth.sessionId, -1, 3600);
    const loggedOut = await loginSession(testApp, alice.username, alice.password);
    expect(
      (await authed(testApp, 'POST', '/api/v1/auth/logout', loggedOut.auth.accessToken)).statusCode,
    ).toBe(204);
    const bob = await registerUser(testApp);

    const { response, items } = await listSessions(second.auth.accessToken);
    expect(response.headers['cache-control']).toBe('no-store');
    expect(items.map((item) => item.id)).toEqual([
      third.auth.sessionId,
      second.auth.sessionId,
      alice.auth.sessionId,
    ]);
    expect(items.filter((item) => item.current).map((item) => item.id)).toEqual([second.auth.sessionId]);
    expect(items.map((item) => item.id)).not.toContain(bob.auth.sessionId);
    const secondItem = items.find((item) => item.id === second.auth.sessionId);
    expect(secondItem).toMatchObject({ userAgent: 'Second browser', current: true });
    expect(secondItem?.ip).toMatch(/^10\./);
    // A read: request log only, never an audit row (section 10.4 auth.session_list).
    expect(auditEventsOf(testApp, response)).toEqual([]);
  });

  it('requires authentication (401, not audited)', async () => {
    const response = await testApp.app.inject({ method: 'GET', url: '/api/v1/auth/sessions' });
    expect(response.statusCode).toBe(401);
    expect(problem(response).code).toBe('UNAUTHENTICATED');
    expect(auditEventsOf(testApp, response)).toEqual([]);
  });
});

describe('DELETE /api/v1/auth/sessions/{sessionId}', () => {
  it('revokes an own session: 204, Redis mark, sessions event, audit; its token -> 401 SESSION_REVOKED', async () => {
    const alice = await registerUser(testApp);
    const other = await loginSession(testApp, alice.username, alice.password);
    const eventsBefore = sessionEvents(testApp).length;

    const response = await authed(
      testApp,
      'DELETE',
      `/api/v1/auth/sessions/${other.auth.sessionId}`,
      alice.auth.accessToken,
    );
    expect(response.statusCode).toBe(204);
    expect((await sessionRow(testApp, other.auth.sessionId)).revoked_reason).toBe('user_revoked');
    expect(await testApp.container.revocations.isRevoked(other.auth.sessionId)).toBe(true);
    expect(sessionEvents(testApp).slice(eventsBefore)).toEqual([
      {
        kind: 'revoked',
        sessionId: other.auth.sessionId,
        userId: alice.auth.user.id,
        reason: 'user_revoked',
      },
    ]);
    expect(auditEventsOf(testApp, response)).toEqual([
      expect.objectContaining({
        action: 'auth.session_revoke',
        outcome: 'success',
        actorId: alice.auth.user.id,
        sessionId: alice.auth.sessionId,
        targetType: 'session',
        targetId: other.auth.sessionId,
        details: { revokedSessionId: other.auth.sessionId },
      }),
    ]);

    const revokedMe = await authed(testApp, 'GET', '/api/v1/auth/me', other.auth.accessToken);
    expect(revokedMe.statusCode).toBe(401);
    expect(problem(revokedMe).code).toBe('SESSION_REVOKED');
    const { items } = await listSessions(alice.auth.accessToken);
    expect(items.map((item) => item.id)).toEqual([alice.auth.sessionId]);

    // A retried DELETE of the same own session is a quiet success (no second event).
    const again = await authed(
      testApp,
      'DELETE',
      `/api/v1/auth/sessions/${other.auth.sessionId}`,
      alice.auth.accessToken,
    );
    expect(again.statusCode).toBe(204);
    expect(sessionEvents(testApp).slice(eventsBefore)).toHaveLength(1);
  });

  it("answers 404 for another user's session, recorded as ONE auth.session_revoke failure (NOT_FOUND)", async () => {
    const alice = await registerUser(testApp);
    const bob = await registerUser(testApp);
    const response = await authed(
      testApp,
      'DELETE',
      `/api/v1/auth/sessions/${bob.auth.sessionId}`,
      alice.auth.accessToken,
    );
    expect(response.statusCode).toBe(404);
    expect(problem(response).code).toBe('NOT_FOUND');
    expect(auditEventsOf(testApp, response)).toEqual([
      expect.objectContaining({
        action: 'auth.session_revoke',
        outcome: 'failure',
        actorId: alice.auth.user.id,
        targetType: 'session',
        targetId: bob.auth.sessionId,
        details: { code: 'NOT_FOUND', status: 404 },
      }),
    ]);
    expect((await sessionRow(testApp, bob.auth.sessionId)).revoked_at).toBeNull();
    expect((await authed(testApp, 'GET', '/api/v1/auth/me', bob.auth.accessToken)).statusCode).toBe(200);
  });

  it('answers 404 for an unknown id and 400 for a malformed one (both audited once)', async () => {
    const alice = await registerUser(testApp);
    const unknown = await authed(
      testApp,
      'DELETE',
      '/api/v1/auth/sessions/0f0b6f1e-6c1e-4f0e-8a44-7d1f0f7b9c21',
      alice.auth.accessToken,
    );
    expect(unknown.statusCode).toBe(404);
    expect(auditEventsOf(testApp, unknown)).toHaveLength(1);

    const malformed = await authed(
      testApp,
      'DELETE',
      '/api/v1/auth/sessions/not-a-uuid',
      alice.auth.accessToken,
      {
        ip: uniqueIp(),
      },
    );
    expect(malformed.statusCode).toBe(400);
    expect(problem(malformed).code).toBe('VALIDATION_FAILED');
    expect(auditEventsOf(testApp, malformed)).toEqual([
      expect.objectContaining({
        action: 'auth.session_revoke',
        outcome: 'failure',
        details: { code: 'VALIDATION_FAILED', status: 400 },
      }),
    ]);
  });
});

describe('GET /api/v1/auth/me', () => {
  it('returns the user and the current session, and 401 SESSION_REVOKED once the DB revoked it', async () => {
    const alice = await registerUser(testApp, { displayName: 'Alice Me' });
    const me = await authed(testApp, 'GET', '/api/v1/auth/me', alice.auth.accessToken);
    expect(me.statusCode).toBe(200);
    expect(me.headers['cache-control']).toBe('no-store');
    expect(me.json()).toMatchObject({
      user: { id: alice.auth.user.id, displayName: 'Alice Me', role: 'user' },
      session: { id: alice.auth.sessionId, current: true },
    });

    // Revoked in the database only (as when the Redis mark failed): the database is authoritative.
    await revokeSessionInDb(testApp.container, alice.auth.sessionId, 'admin');
    const after = await authed(testApp, 'GET', '/api/v1/auth/me', alice.auth.accessToken);
    expect(after.statusCode).toBe(401);
    expect(problem(after).code).toBe('SESSION_REVOKED');
  });
});
