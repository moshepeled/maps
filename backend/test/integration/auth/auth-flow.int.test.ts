/**
 * Accounts, login and logout through the real endpoints (SPEC section 6.1, section 6.2, section 10.1, section 10.4): register -> login -> me ->
 * logout with immediate token revocation, role and colour rules, sanitised display names, identical 401s for unknown
 * users and wrong passwords (with the dummy-hash verification observed), the (username, IP) lockout and its audit
 * trail (concurrent bursts: qa-login-lockout-race.int), disabled accounts including a login racing a disable, and
 * long User-Agents.
 */
import { randomUUID } from 'node:crypto';

import { verify } from '@node-rs/argon2';
import { COLOR_PATTERN, USER_PALETTE, codePointLength } from '@snapland/shared';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { DUMMY_PASSWORD_HASH } from '../../../src/modules/auth/index.js';
import { LOGIN_FAILURE_LIMITS } from '../../../src/modules/auth/login-failures.js';
import { uniqueIp } from '../../helpers/net.js';
import { createTcpProxy } from '../../helpers/tcp-proxy.js';
import { createUser, DEFAULT_TEST_PASSWORD, disableUserInDb, nextUsername } from '../../helpers/users.js';
import { waitFor } from '../../helpers/wait-for.js';
import {
  PASSWORD,
  auditEvents,
  auditEventsOf,
  authBody,
  authed,
  createAuthTestApp,
  existingKeyCount,
  failureCounterKeys,
  login,
  loginSession,
  problem,
  rawRefreshCookie,
  refresh,
  refreshCookie,
  register,
  registerUser,
  sessionEvents,
  sessionIdsOfUser,
  sessionRow,
  userRow,
  whileDisablingUser,
} from './auth-test-kit.js';
import type { AuthTestApp } from './auth-test-kit.js';

/** A spy around the real argon2 `verify`: the dummy-hash verification of unknown users is observed through it. */
vi.mock('@node-rs/argon2', async (importOriginal) => {
  const m = await importOriginal<{ verify: typeof verify }>();
  return { ...m, verify: vi.fn(m.verify) };
});

let testApp: AuthTestApp;

beforeAll(async () => {
  testApp = await createAuthTestApp();
});

afterAll(async () => {
  await testApp.close();
});

describe('register -> login -> me -> logout (section 6.2)', () => {
  it('works end to end, and logout rejects the old access token at once (401 SESSION_REVOKED)', async () => {
    const username = nextUsername('flow');
    const registered = await register(testApp, { username, password: PASSWORD, displayName: 'Flow User' });
    expect(registered.statusCode).toBe(201);
    expect(registered.headers['cache-control']).toBe('no-store');
    const created = authBody(registered);
    expect(created.user).toMatchObject({ username, displayName: 'Flow User', role: 'user' });
    expect(refreshCookie(registered).value).toMatch(/^[A-Za-z0-9_-]{43}$/);

    const loggedIn = await login(testApp, username.toUpperCase(), PASSWORD);
    expect(loggedIn.statusCode).toBe(200);
    const session = authBody(loggedIn);
    expect(session.user).toEqual(created.user);
    expect(session.sessionId).not.toBe(created.sessionId);
    expect(new Date(session.accessTokenExpiresAt).getTime()).toBeGreaterThan(Date.now());

    const me = await authed(testApp, 'GET', '/api/v1/auth/me', session.accessToken);
    expect(me.statusCode).toBe(200);
    expect(me.json()).toMatchObject({
      user: created.user,
      session: { id: session.sessionId, current: true },
    });

    const logout = await authed(testApp, 'POST', '/api/v1/auth/logout', session.accessToken);
    expect(logout.statusCode).toBe(204);
    const cleared = rawRefreshCookie(logout);
    expect(cleared).toMatch(/^snap_rt=;/);
    expect(cleared).toMatch(/Path=\/api\/v1\/auth/);
    expect(cleared).toMatch(/Expires=Thu, 01 Jan 1970|Max-Age=0/);

    const after = await authed(testApp, 'GET', '/api/v1/auth/me', session.accessToken);
    expect(after.statusCode).toBe(401);
    expect(problem(after).code).toBe('SESSION_REVOKED');
    expect((await sessionRow(testApp, session.sessionId)).revoked_reason).toBe('logout');
    expect(sessionEvents(testApp)).toContainEqual({
      kind: 'revoked',
      sessionId: session.sessionId,
      userId: created.user.id,
      reason: 'logout',
    });
    // The registration session is unaffected by the logout of the other one.
    expect((await authed(testApp, 'GET', '/api/v1/auth/me', created.accessToken)).statusCode).toBe(200);

    const userId = created.user.id;
    expect(auditEventsOf(testApp, registered)).toEqual([
      expect.objectContaining({
        action: 'auth.register',
        outcome: 'success',
        actorId: userId,
        sessionId: created.sessionId,
        targetType: 'user',
        targetId: userId,
      }),
    ]);
    expect(auditEventsOf(testApp, loggedIn)).toEqual([
      expect.objectContaining({
        action: 'auth.login',
        outcome: 'success',
        actorId: userId,
        sessionId: session.sessionId,
        targetId: userId,
      }),
    ]);
    expect(auditEventsOf(testApp, logout)).toEqual([
      expect.objectContaining({
        action: 'auth.logout',
        outcome: 'success',
        actorId: userId,
        sessionId: session.sessionId,
        targetType: 'session',
        targetId: session.sessionId,
      }),
    ]);
    // Reads are never audit rows.
    expect(auditEventsOf(testApp, me)).toEqual([]);
  });

  it('sets the refresh cookie with the section 6.2 attributes (HttpOnly; Secure; SameSite=Strict; Path; Max-Age)', async () => {
    const response = await register(testApp, {
      username: nextUsername('cookie'),
      password: PASSWORD,
      displayName: 'Cookie',
    });
    const raw = rawRefreshCookie(response);
    expect(raw).toMatch(/; HttpOnly/);
    expect(raw).toMatch(/; Secure/);
    expect(raw).toMatch(/; SameSite=Strict/);
    expect(raw).toMatch(/; Path=\/api\/v1\/auth(;|$)/);
    expect(raw).toContain(`Max-Age=${testApp.config.REFRESH_TOKEN_TTL_S}`);
  });

  it('logout of an already revoked session is a quiet 204', async () => {
    const user = await registerUser(testApp);
    const first = await authed(testApp, 'POST', '/api/v1/auth/logout', user.auth.accessToken);
    expect(first.statusCode).toBe(204);
    // The Redis mark is gone (as after a Redis outage): the database says revoked, the token still passes authenticate.
    await testApp.container.redis.cmd.del(testApp.container.keys.revokedSession(user.auth.sessionId));
    const eventsBefore = sessionEvents(testApp).length;
    const second = await authed(testApp, 'POST', '/api/v1/auth/logout', user.auth.accessToken);
    expect(second.statusCode).toBe(204);
    expect(sessionEvents(testApp)).toHaveLength(eventsBefore);
    expect(auditEventsOf(testApp, second)).toEqual([
      expect.objectContaining({
        action: 'auth.logout',
        outcome: 'success',
        details: { alreadyRevoked: true },
      }),
    ]);
  });
});

describe('registration rules (section 6.2)', () => {
  it('registering "admin" yields role user; the colour is a USER_PALETTE colour in the CHECK format', async () => {
    const response = await register(testApp, {
      username: 'admin',
      password: PASSWORD,
      displayName: 'Not an admin',
    });
    expect(response.statusCode).toBe(201);
    const { user } = authBody(response);
    expect(user.role).toBe('user');
    expect(user.color).toMatch(/^#[0-9a-f]{6}$/);
    expect(user.color).toMatch(new RegExp(COLOR_PATTERN));
    expect(USER_PALETTE).toContain(user.color);
    expect((await userRow(testApp, 'admin')).role).toBe('user');
  });

  it('rejects a taken username case-insensitively with 409 USERNAME_TAKEN (audited)', async () => {
    const user = await registerUser(testApp);
    const response = await register(testApp, {
      username: user.username.toUpperCase(),
      password: PASSWORD,
      displayName: 'Copycat',
    });
    expect(response.statusCode).toBe(409);
    expect(problem(response).code).toBe('USERNAME_TAKEN');
    expect(auditEventsOf(testApp, response)).toEqual([
      expect.objectContaining({
        action: 'auth.register',
        outcome: 'failure',
        actorId: null,
        details: { reason: 'username_taken', code: 'USERNAME_TAKEN', status: 409 },
      }),
    ]);
  });

  it('sanitises the display name, and rejects one that is empty after sanitising (400, audited)', async () => {
    const username = nextUsername('san');
    const ok = await register(testApp, {
      username,
      password: PASSWORD,
      displayName: '  Ada​   Lovelace‮  ',
    });
    expect(ok.statusCode).toBe(201);
    expect(authBody(ok).user.displayName).toBe('Ada Lovelace');

    const empty = await register(testApp, {
      username: nextUsername('san'),
      password: PASSWORD,
      displayName: ' ​⁦ ',
    });
    expect(empty.statusCode).toBe(400);
    expect(problem(empty)).toMatchObject({
      code: 'VALIDATION_FAILED',
      errors: [expect.objectContaining({ path: 'body.displayName', code: 'empty' })],
    });
    expect(auditEventsOf(testApp, empty)).toEqual([
      expect.objectContaining({
        action: 'auth.register',
        outcome: 'failure',
        details: { reason: 'invalid_display_name', code: 'VALIDATION_FAILED', status: 400 },
      }),
    ]);
  });

  it('a transport 400 (unknown key, short password) is recorded once by the generic hook', async () => {
    for (const body of [
      { username: nextUsername(), password: PASSWORD, displayName: 'X', role: 'admin' },
      { username: nextUsername(), password: 'short', displayName: 'X' },
    ]) {
      const response = await register(testApp, body);
      expect(response.statusCode).toBe(400);
      expect(problem(response).code).toBe('VALIDATION_FAILED');
      expect(auditEventsOf(testApp, response)).toEqual([
        expect.objectContaining({
          action: 'auth.register',
          outcome: 'failure',
          details: { code: 'VALIDATION_FAILED', status: 400 },
        }),
      ]);
    }
  });

  it('answers 415 for a non-JSON body (generic audit failure)', async () => {
    const response = await testApp.app.inject({
      method: 'POST',
      url: '/api/v1/auth/register',
      remoteAddress: uniqueIp(),
      headers: { 'content-type': 'text/plain' },
      payload: 'username=x',
    });
    expect(response.statusCode).toBe(415);
    expect(auditEventsOf(testApp, response)).toEqual([
      expect.objectContaining({
        action: 'auth.register',
        outcome: 'failure',
        details: { code: 'UNSUPPORTED_MEDIA_TYPE', status: 415 },
      }),
    ]);
  });
});

describe('login (section 6.2)', () => {
  it('answers unknown user and wrong password with byte-identical 401 bodies, verifying the dummy hash', async () => {
    const user = await registerUser(testApp);
    const pinned = { 'x-request-id': `pinned-${nextUsername()}` };

    const argonVerify = vi.mocked(verify);
    argonVerify.mockClear();
    const unknown = await login(testApp, nextUsername('ghost'), PASSWORD, { headers: pinned });
    expect(argonVerify).toHaveBeenCalledTimes(1);
    expect(argonVerify).toHaveBeenCalledWith(DUMMY_PASSWORD_HASH, PASSWORD);

    argonVerify.mockClear();
    const wrong = await login(testApp, user.username, 'wrong-password', { headers: pinned });
    expect(argonVerify).toHaveBeenCalledTimes(1);
    expect(argonVerify.mock.calls[0]?.[0]).not.toBe(DUMMY_PASSWORD_HASH);

    expect(unknown.statusCode).toBe(401);
    expect(wrong.statusCode).toBe(401);
    expect(problem(unknown).code).toBe('INVALID_CREDENTIALS');
    expect(unknown.rawPayload.equals(wrong.rawPayload)).toBe(true);

    const failures = auditEvents(testApp, 'auth.login').filter(
      (event) => event.requestId === pinned['x-request-id'],
    );
    expect(failures).toEqual([
      expect.objectContaining({
        outcome: 'failure',
        targetId: null,
        details: { reason: 'invalid_credentials' },
      }),
      expect.objectContaining({
        outcome: 'failure',
        targetId: user.auth.user.id,
        details: { reason: 'invalid_credentials' },
      }),
    ]);
  });

  it('accepts a 600-character User-Agent and stores at most 512 code points', async () => {
    const user = await registerUser(testApp);
    const response = await login(testApp, user.username, PASSWORD, {
      headers: { 'user-agent': 'U'.repeat(600) },
    });
    expect(response.statusCode).toBe(200);
    const stored = await sessionRow(testApp, authBody(response).sessionId);
    expect(stored.user_agent).toBe('U'.repeat(512));
    expect(codePointLength(stored.user_agent ?? '')).toBeLessThanOrEqual(512);
  });

  it('refuses a disabled account with 403 ACCOUNT_DISABLED only after a correct password (audited as denied)', async () => {
    const user = await registerUser(testApp);
    await disableUserInDb(testApp.container, user.auth.user.id);

    const wrong = await login(testApp, user.username, 'not-the-password');
    expect(wrong.statusCode).toBe(401);
    expect(problem(wrong).code).toBe('INVALID_CREDENTIALS');

    const right = await login(testApp, user.username, PASSWORD);
    expect(right.statusCode).toBe(403);
    expect(problem(right).code).toBe('ACCOUNT_DISABLED');
    expect(auditEventsOf(testApp, right)).toEqual([
      expect.objectContaining({
        action: 'auth.login',
        outcome: 'denied',
        targetId: user.auth.user.id,
        details: { reason: 'disabled' },
      }),
    ]);
  });

  it('a login racing a disable starts no session: its INSERT waits for the disable, then finds the user disabled', async () => {
    const user = await registerUser(testApp);
    const pending = await whileDisablingUser(testApp, user.auth.user.id, async (anotherBackendWaits) => {
      // The password check reads the committed (still enabled) row; only the session INSERT waits for the row lock.
      const attempt = login(testApp, user.username, PASSWORD);
      await waitFor(anotherBackendWaits, {
        description: 'the session INSERT waits for the disabling transaction',
      });
      return { attempt };
    });

    const response = await pending.attempt;
    expect(response.statusCode).toBe(403);
    expect(problem(response).code).toBe('ACCOUNT_DISABLED');
    expect(auditEventsOf(testApp, response)).toEqual([
      expect.objectContaining({
        action: 'auth.login',
        outcome: 'denied',
        targetId: user.auth.user.id,
        details: { reason: 'disabled' },
      }),
    ]);
    // Only the registration session exists: no session escaped the disable's revocation.
    expect(await sessionIdsOfUser(testApp, user.auth.user.id)).toEqual([user.auth.sessionId]);
  });

  it('logs in users created by the fixture helper (argon2id hashes with other parameters verify too)', async () => {
    const fixtureUser = await createUser(testApp.container);
    const response = await login(testApp, fixtureUser.username, DEFAULT_TEST_PASSWORD);
    expect(response.statusCode).toBe(200);
    expect(authBody(response).user.color).toBe(fixtureUser.color);
  });
});

describe('login lockout (section 6.2, section 10.1)', () => {
  it('locks (username, IP) at the 6th failure within 15 min with 429 scope login, one coalesced audit row and a metric', async () => {
    const user = await registerUser(testApp);
    const ip = uniqueIp();
    for (let attempt = 1; attempt <= 5; attempt += 1) {
      const failed = await login(testApp, user.username, `wrong-${attempt}`, { ip });
      expect(failed.statusCode, `attempt ${attempt}`).toBe(401);
    }

    const locked = await login(testApp, user.username, PASSWORD, { ip });
    expect(locked.statusCode).toBe(429);
    const body = problem(locked);
    expect(body).toMatchObject({ code: 'RATE_LIMITED', scope: 'login', limit: 5 });
    expect(Number(body['retryAfterMs'])).toBeGreaterThan(0);
    expect(Number(body['retryAfterMs'])).toBeLessThanOrEqual(900_000);
    const retryAfter = Number(locked.headers['retry-after']);
    expect(retryAfter).toBeGreaterThan(0);
    expect(retryAfter).toBeLessThanOrEqual(900);

    const hitsOf = () =>
      auditEvents(testApp, 'ratelimit.hit').filter(
        (event) => event.details['scope'] === 'login' && event.ip === ip,
      );
    expect(hitsOf()).toEqual([
      expect.objectContaining({
        outcome: 'denied',
        actorId: null,
        details: expect.objectContaining({ scope: 'login', transport: 'rest', count: 1 }) as unknown,
      }),
    ]);
    expect(
      auditEvents(testApp, 'auth.login').filter(
        (event) => event.ip === ip && event.outcome === 'denied' && event.details['reason'] === 'locked',
      ),
    ).toHaveLength(1);

    // Two more refused attempts in the same 10 s window are counted into ONE more row when the window closes.
    for (let attempt = 0; attempt < 2; attempt += 1) {
      expect((await login(testApp, user.username, PASSWORD, { ip })).statusCode).toBe(429);
    }
    expect(hitsOf()).toHaveLength(1);
    await testApp.container.auditCoalescer.flush();
    const rows = hitsOf();
    expect(rows).toHaveLength(2);
    expect(rows.reduce((sum, event) => sum + Number(event.details['count']), 0)).toBe(3);

    const counter = await testApp.container.metrics.rateLimitRejectionsTotal.get();
    const loginRejections = counter.values.find(
      (value) => value.labels.scope === 'login' && value.labels.transport === 'rest',
    );
    expect(loginRejections?.value).toBe(3);

    // The same username from another address is still accepted (the tight limit is per (username, IP)).
    expect((await login(testApp, user.username, PASSWORD, { ip: uniqueIp() })).statusCode).toBe(200);
  });

  it('a successful login resets both failure counters', async () => {
    const user = await registerUser(testApp);
    const ip = uniqueIp();
    for (let attempt = 0; attempt < 4; attempt += 1) {
      expect((await login(testApp, user.username, 'wrong', { ip })).statusCode).toBe(401);
    }
    const prefix = testApp.container.keys.prefix;
    const countersBefore = await testApp.container.redis.cmd.keys(`${prefix}rl:login:*`);
    expect(countersBefore.length).toBeGreaterThanOrEqual(2);

    await loginSession(testApp, user.username, PASSWORD, { ip });

    // 5 more failures are allowed again before the lock (the counter restarted at 0).
    for (let attempt = 0; attempt < 5; attempt += 1) {
      expect((await login(testApp, user.username, 'wrong', { ip })).statusCode).toBe(401);
    }
    expect((await login(testApp, user.username, PASSWORD, { ip })).statusCode).toBe(429);
  });

  it('attempts that are not failed guesses (a disabled account, correct password) are given back and never lock', async () => {
    const user = await registerUser(testApp);
    await disableUserInDb(testApp.container, user.auth.user.id);
    const ip = uniqueIp();
    for (let attempt = 1; attempt <= LOGIN_FAILURE_LIMITS.perUserIp + 1; attempt += 1) {
      const response = await login(testApp, user.username, PASSWORD, { ip });
      expect(response.statusCode, `attempt ${attempt}`).toBe(403);
    }
    expect(await existingKeyCount(testApp, failureCounterKeys(testApp, user.username, ip))).toBe(0);
  });

  it('fails open while Redis is unreachable: login keeps working (the DB is authoritative)', async () => {
    const proxy = await createTcpProxy(process.env['REDIS_URL'] ?? '');
    const degraded = await createAuthTestApp({ config: { REDIS_URL: proxy.url } });
    try {
      const user = await registerUser(degraded);
      proxy.pause();
      await waitFor(() => degraded.container.redis.cmd.status !== 'ready');
      expect((await login(degraded, user.username, 'wrong-password')).statusCode).toBe(401);
      expect((await login(degraded, user.username, PASSWORD)).statusCode).toBe(200);
    } finally {
      await degraded.close();
      await proxy.close();
    }
  });
});

describe('generic failure rows (section 10.4: outcomes the services never see)', () => {
  it('a body over BODY_LIMIT_BYTES -> 413, recorded once by the audit hook', async () => {
    const response = await register(testApp, {
      username: nextUsername(),
      password: PASSWORD,
      displayName: 'x'.repeat(testApp.config.BODY_LIMIT_BYTES),
    });
    expect(response.statusCode).toBe(413);
    expect(auditEventsOf(testApp, response)).toEqual([
      expect.objectContaining({
        action: 'auth.register',
        outcome: 'failure',
        details: { code: 'PAYLOAD_TOO_LARGE', status: 413 },
      }),
    ]);
  });

  it('with PostgreSQL unreachable, register/login/refresh/logout answer 503, each recorded once', async () => {
    const offline = await createAuthTestApp({ config: { DATABASE_URL: 'postgres://x:x@127.0.0.1:1/x' } });
    try {
      const { token } = await offline.container.accessTokens.sign({
        userId: randomUUID(),
        sessionId: randomUUID(),
        username: 'offline',
        displayName: 'Offline',
        role: 'user',
      });
      const responses = {
        'auth.register': await register(offline, {
          username: nextUsername(),
          password: PASSWORD,
          displayName: 'Offline',
        }),
        'auth.login': await login(offline, nextUsername(), PASSWORD),
        'auth.refresh': await refresh(offline, 'B'.repeat(43)),
        'auth.logout': await authed(offline, 'POST', '/api/v1/auth/logout', token),
      } as const;
      for (const [action, response] of Object.entries(responses)) {
        expect(response.statusCode, action).toBe(503);
        expect(problem(response).code, action).toBe('DEPENDENCY_UNAVAILABLE');
        expect(auditEventsOf(offline, response), action).toEqual([
          expect.objectContaining({
            action,
            outcome: 'failure',
            details: { code: 'DEPENDENCY_UNAVAILABLE', status: 503 },
          }),
        ]);
      }
    } finally {
      await offline.close();
    }
  });
});
