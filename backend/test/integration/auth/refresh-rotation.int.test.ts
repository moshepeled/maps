/**
 * Refresh-token rotation (SPEC section 6.2): rotation with a sliding (capped) expiry, the 10 s parallel-tab window, reuse
 * detection (> 10 s -> session revoked, `sessions` event, `auth.token_reuse`), expired and revoked sessions, the cookie
 * attributes, a real two-request race, and the separate `refresh` rate-limit bucket (section 10.1). Elapsed time is simulated
 * by moving the session's timestamps back in the database (the service decides with the database clock).
 */
import { createHash } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { uniqueIp } from '../../helpers/net.js';
import { createUser, disableUserInDb } from '../../helpers/users.js';
import {
  auditEventsOf,
  authBody,
  authed,
  backdateRotation,
  createAuthTestApp,
  loginSession,
  problem,
  rawRefreshCookie,
  refresh,
  refreshCookie,
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

function sha256(token: string): Buffer {
  return createHash('sha256').update(token).digest();
}

describe('rotation (section 6.2 rule 1)', () => {
  it('issues a new refresh token and access token for the same session, sliding the expiry', async () => {
    const user = await registerUser(testApp);
    const before = await sessionRow(testApp, user.auth.sessionId);

    const response = await refresh(testApp, user.refreshToken);
    expect(response.statusCode).toBe(200);
    expect(response.headers['cache-control']).toBe('no-store');
    const body = authBody(response);
    expect(body.sessionId).toBe(user.auth.sessionId);
    expect(body.user).toEqual(user.auth.user);
    const rotated = refreshCookie(response).value;
    expect(rotated).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(rotated).not.toBe(user.refreshToken);

    const after = await sessionRow(testApp, user.auth.sessionId);
    expect(after.refresh_token_hash).toEqual(sha256(rotated));
    expect(after.previous_token_hash).toEqual(sha256(user.refreshToken));
    expect(after.rotated_at).not.toBeNull();
    expect(after.expires_at.getTime()).toBeGreaterThanOrEqual(before.expires_at.getTime());
    expect(after.absolute_expires_at).toEqual(before.absolute_expires_at);

    // The new access token works; so does the new refresh token.
    expect((await authed(testApp, 'GET', '/api/v1/auth/me', body.accessToken)).statusCode).toBe(200);
    expect((await refresh(testApp, rotated)).statusCode).toBe(200);

    expect(auditEventsOf(testApp, response)).toEqual([
      expect.objectContaining({
        action: 'auth.refresh',
        outcome: 'success',
        actorId: user.auth.user.id,
        sessionId: user.auth.sessionId,
        targetType: 'session',
        targetId: user.auth.sessionId,
      }),
    ]);
  });

  it('never extends the sliding expiry or the cookie past the absolute expiry', async () => {
    const user = await registerUser(testApp);
    const fresh = await refresh(testApp, user.refreshToken);
    expect(refreshCookie(fresh).maxAge).toBe(testApp.config.REFRESH_TOKEN_TTL_S);

    // One hour left of the absolute lifetime: the sliding expiry and the cookie stop there.
    await setSessionExpiry(testApp, user.auth.sessionId, 60, 3600);
    const capped = await refresh(testApp, refreshCookie(fresh).value);
    expect(capped.statusCode).toBe(200);
    const row = await sessionRow(testApp, user.auth.sessionId);
    expect(Math.abs(row.expires_at.getTime() - row.absolute_expires_at.getTime())).toBeLessThan(1000);
    const maxAge = refreshCookie(capped).maxAge ?? 0;
    expect(maxAge).toBeGreaterThan(3590);
    expect(maxAge).toBeLessThanOrEqual(3600);
  });
});

describe('previous token (section 6.2 rule 2)', () => {
  it('within 10 s of the rotation: 401 REFRESH_TOKEN_INVALID, nothing revoked (parallel tabs)', async () => {
    const user = await registerUser(testApp);
    const rotated = refreshCookie(await refresh(testApp, user.refreshToken)).value;
    const eventsBefore = sessionEvents(testApp).length;

    const replay = await refresh(testApp, user.refreshToken);
    expect(replay.statusCode).toBe(401);
    expect(problem(replay).code).toBe('REFRESH_TOKEN_INVALID');
    expect((await sessionRow(testApp, user.auth.sessionId)).revoked_at).toBeNull();
    expect(sessionEvents(testApp)).toHaveLength(eventsBefore);
    expect((await refresh(testApp, rotated)).statusCode).toBe(200);
    expect(auditEventsOf(testApp, replay)).toEqual([
      expect.objectContaining({
        action: 'auth.refresh',
        outcome: 'failure',
        targetId: user.auth.sessionId,
        details: { reason: 'race' },
      }),
    ]);
  });

  it('more than 10 s later: reuse -> 401 REFRESH_TOKEN_REUSED, session revoked, sessions event, audit', async () => {
    const user = await registerUser(testApp);
    const second = await refresh(testApp, user.refreshToken);
    const rotated = refreshCookie(second).value;
    const accessToken = authBody(second).accessToken;
    await backdateRotation(testApp, user.auth.sessionId, 11);

    const reuse = await refresh(testApp, user.refreshToken);
    expect(reuse.statusCode).toBe(401);
    expect(problem(reuse).code).toBe('REFRESH_TOKEN_REUSED');

    const row = await sessionRow(testApp, user.auth.sessionId);
    expect(row.revoked_reason).toBe('token_reuse');
    expect(row.revoked_at).not.toBeNull();
    expect(sessionEvents(testApp)).toContainEqual({
      kind: 'revoked',
      sessionId: user.auth.sessionId,
      userId: user.auth.user.id,
      reason: 'token_reuse',
    });
    expect(auditEventsOf(testApp, reuse)).toEqual([
      expect.objectContaining({
        action: 'auth.token_reuse',
        outcome: 'denied',
        actorId: user.auth.user.id,
        targetType: 'session',
        targetId: user.auth.sessionId,
        details: {},
      }),
    ]);

    // Everything of that session is dead now: the access token at once (Redis mark), the current refresh token too.
    const me = await authed(testApp, 'GET', '/api/v1/auth/me', accessToken);
    expect(me.statusCode).toBe(401);
    expect(problem(me).code).toBe('SESSION_REVOKED');
    const current = await refresh(testApp, rotated);
    expect(current.statusCode).toBe(401);
    expect(problem(current).code).toBe('SESSION_REVOKED');
  });

  it('the loser of a real concurrent refresh race gets REFRESH_TOKEN_INVALID and the session survives', async () => {
    const user = await registerUser(testApp);
    const responses = await Promise.all([
      refresh(testApp, user.refreshToken),
      refresh(testApp, user.refreshToken),
    ]);
    const statuses = responses.map((response) => response.statusCode).sort();
    expect(statuses).toEqual([200, 401]);
    const loser = responses.find((response) => response.statusCode === 401);
    expect(loser === undefined ? null : problem(loser).code).toBe('REFRESH_TOKEN_INVALID');
    const winner = responses.find((response) => response.statusCode === 200);
    expect(winner).toBeDefined();
    if (winner !== undefined)
      expect((await refresh(testApp, refreshCookie(winner).value)).statusCode).toBe(200);
    expect((await sessionRow(testApp, user.auth.sessionId)).revoked_at).toBeNull();
  });
});

describe('invalid, expired and revoked (section 6.2 rule 3)', () => {
  it.each([
    ['missing', undefined],
    ['malformed', 'not-a-token'],
    ['unknown', 'A'.repeat(43)],
  ])('%s cookie -> 401 REFRESH_TOKEN_INVALID (audited)', async (reason, token) => {
    const response = await refresh(testApp, token);
    expect(response.statusCode).toBe(401);
    expect(problem(response).code).toBe('REFRESH_TOKEN_INVALID');
    expect(auditEventsOf(testApp, response)).toEqual([
      expect.objectContaining({
        action: 'auth.refresh',
        outcome: 'failure',
        actorId: null,
        targetId: null,
        details: { reason },
      }),
    ]);
  });

  it('a session past its sliding or absolute expiry -> 401 REFRESH_TOKEN_INVALID', async () => {
    const sliding = await registerUser(testApp);
    await setSessionExpiry(testApp, sliding.auth.sessionId, -1, 3600);
    const slidingResponse = await refresh(testApp, sliding.refreshToken);
    expect(slidingResponse.statusCode).toBe(401);
    expect(problem(slidingResponse).code).toBe('REFRESH_TOKEN_INVALID');
    expect(auditEventsOf(testApp, slidingResponse)).toEqual([
      expect.objectContaining({ details: { reason: 'expired' } }),
    ]);

    const absolute = await registerUser(testApp);
    await setSessionExpiry(testApp, absolute.auth.sessionId, -2, -1);
    const absoluteResponse = await refresh(testApp, absolute.refreshToken);
    expect(absoluteResponse.statusCode).toBe(401);
    expect(problem(absoluteResponse).code).toBe('REFRESH_TOKEN_INVALID');
  });

  it('a logged-out session or a disabled user -> 401 SESSION_REVOKED', async () => {
    const user = await registerUser(testApp);
    expect((await authed(testApp, 'POST', '/api/v1/auth/logout', user.auth.accessToken)).statusCode).toBe(
      204,
    );
    const afterLogout = await refresh(testApp, user.refreshToken);
    expect(afterLogout.statusCode).toBe(401);
    expect(problem(afterLogout).code).toBe('SESSION_REVOKED');
    expect(auditEventsOf(testApp, afterLogout)).toEqual([
      expect.objectContaining({ action: 'auth.refresh', outcome: 'failure', details: { reason: 'revoked' } }),
    ]);

    const disabled = await registerUser(testApp);
    await disableUserInDb(testApp.container, disabled.auth.user.id);
    const afterDisable = await refresh(testApp, disabled.refreshToken);
    expect(afterDisable.statusCode).toBe(401);
    expect(problem(afterDisable).code).toBe('SESSION_REVOKED');
  });
});

describe('cookie without Secure (COOKIE_SECURE=false, plain-HTTP development)', () => {
  it('omits Secure and keeps the other attributes', async () => {
    const plain = await createAuthTestApp({ config: { COOKIE_SECURE: false } });
    try {
      const user = await registerUser(plain);
      const raw = rawRefreshCookie(await refresh(plain, user.refreshToken));
      expect(raw).not.toMatch(/; Secure/);
      expect(raw).toMatch(/; HttpOnly/);
      expect(raw).toMatch(/; SameSite=Strict/);
    } finally {
      await plain.close();
    }
  });
});

describe('rate-limit buckets (section 6, section 10.1)', () => {
  it('refresh has its own bucket: with AUTH_RATE_LIMIT_MAX=2, 5 refreshes succeed and the 3rd login -> 429 auth', async () => {
    const limited = await createAuthTestApp({ config: { AUTH_RATE_LIMIT_MAX: 2 } });
    try {
      const user = await createUser(limited.container);
      const ip = uniqueIp();
      await loginSession(limited, user.username, user.password, { ip });
      let { refreshToken } = await loginSession(limited, user.username, user.password, { ip });
      for (let i = 0; i < 5; i += 1) {
        const response = await refresh(limited, refreshToken, { ip });
        expect(response.statusCode, `refresh ${i + 1}`).toBe(200);
        refreshToken = refreshCookie(response).value;
      }
      const third = await limited.app.inject({
        method: 'POST',
        url: '/api/v1/auth/login',
        remoteAddress: ip,
        payload: { username: user.username, password: user.password },
      });
      expect(third.statusCode).toBe(429);
      expect(problem(third)).toMatchObject({ code: 'RATE_LIMITED', scope: 'auth', limit: 2 });
      expect(Number(third.headers['retry-after'])).toBeGreaterThan(0);
    } finally {
      await limited.close();
    }
  });
});
