/**
 * The operator CLI `scripts/user-admin.ts` (SPEC section 6.2, section 3.8), driven through `run(argv, deps)` against the real
 * database and Redis of a test app: role changes apply on the next admin request with the SAME access token, `disable`
 * revokes every session (Redis marks + one `sessions` event each) and blocks login, `enable` restores it, a Redis
 * outage after the commit exits 1 naming the failed steps (and a re-run delivers them), and the argument contract.
 */
import { pino } from 'pino';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { run } from '../../../src/scripts/user-admin.js';
import type { UserAdminContext, UserAdminDeps } from '../../../src/scripts/user-admin.js';
import { createTcpProxy } from '../../helpers/tcp-proxy.js';
import { waitFor } from '../../helpers/wait-for.js';
import {
  PASSWORD,
  auditEvents,
  authed,
  createAuthTestApp,
  login,
  loginSession,
  problem,
  registerUser,
  sessionEvents,
  sessionRow,
  userRow,
} from './auth-test-kit.js';
import type { AuthTestApp } from './auth-test-kit.js';

const OPERATOR = 'vitest-operator';
let testApp: AuthTestApp;

beforeAll(async () => {
  testApp = await createAuthTestApp({
    routes: (scope) => {
      scope.get(
        '/admin-only',
        { onRequest: [scope.authenticate], preHandler: [scope.requireRole('admin')] },
        () => ({ ok: true }),
      );
    },
  });
});

afterAll(async () => {
  await testApp.close();
});

/** The CLI context over a test app's container (which the test owns and closes itself). */
function contextOf(app: AuthTestApp): UserAdminContext {
  return {
    db: app.container.db,
    revocations: app.container.revocations,
    events: app.container.events,
    audit: app.container.audit,
    accessTokenTtlS: app.config.ACCESS_TOKEN_TTL_S,
    close: () => Promise.resolve(),
  };
}

/** Runs the CLI against a test app's container. */
async function runCli(app: AuthTestApp, argv: string[], overrides: Partial<UserAdminDeps> = {}) {
  let stdout = '';
  let stderr = '';
  const context = contextOf(app);
  const openContext = vi.fn(() => Promise.resolve(context));
  const code = await run(argv, {
    stdout: { write: (chunk: string) => (stdout += chunk) },
    stderr: { write: (chunk: string) => (stderr += chunk) },
    logger: pino({ level: 'silent' }),
    openContext,
    operator: () => OPERATOR,
    ...overrides,
  });
  return { code, stdout, stderr, openContext };
}

function adminOnly(accessToken: string) {
  return authed(testApp, 'GET', '/__test/admin-only', accessToken);
}

describe('user-admin arguments (section 3.8)', () => {
  it('--help prints the usage and exits 0 without touching the database', async () => {
    const result = await runCli(testApp, ['--help']);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('Usage: user-admin <grant-admin|revoke-admin|disable|enable>');
    expect(result.openContext).not.toHaveBeenCalled();
  });

  it.each([
    [['promote', '--username', 'alice']],
    [['grant-admin']],
    [['grant-admin', '--username', 'a!']],
    // Outside the shared registration pattern: no account can have these names (non-ASCII look-alike, NUL).
    [['grant-admin', '--username', 'alİce']],
    [['disable', '--username', 'x\u0000y']],
    [['grant-admin', '--username', 'alice', '--force']],
    [['grant-admin', 'disable', '--username', 'alice']],
    [[]],
  ])('bad arguments %j -> exit 1 with the usage', async (argv) => {
    const result = await runCli(testApp, argv);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('Usage: user-admin');
    expect(result.openContext).not.toHaveBeenCalled();
  });

  it('an unknown user -> exit 1, nothing changed, audited as a failure', async () => {
    const result = await runCli(testApp, ['grant-admin', '--username', 'nobody-here']);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('no user named nobody-here');
    expect(auditEvents(testApp, 'admin.user_update')).toContainEqual(
      expect.objectContaining({
        outcome: 'failure',
        actorId: null,
        details: { op: 'grant-admin', operator: OPERATOR, reason: 'user_not_found', username: 'nobody-here' },
      }),
    );
  });

  it('a configuration or connection failure -> exit 1', async () => {
    const result = await runCli(testApp, ['enable', '--username', 'alice'], {
      openContext: () => Promise.reject(new Error('DATABASE_URL: invalid')),
    });
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('could not start');
  });

  it('a database failure during the change -> exit 1, reported as not completed, audited as db_error', async () => {
    const offline = await createAuthTestApp({ config: { DATABASE_URL: 'postgres://x:x@127.0.0.1:1/x' } });
    try {
      const result = await runCli(offline, ['disable', '--username', 'someone']);
      expect(result.code).toBe(1);
      expect(result.stderr).toContain('the database transaction did not complete');
      expect(result.stdout).toBe('');
      expect(auditEvents(offline, 'admin.user_update')).toEqual([
        expect.objectContaining({
          outcome: 'failure',
          actorId: null,
          targetId: null,
          details: { op: 'disable', operator: OPERATOR, reason: 'db_error', username: 'someone' },
        }),
      ]);
    } finally {
      await offline.close();
    }
  });

  it('a failed shutdown (audit flush) -> exit 1 without hiding the committed outcome', async () => {
    const user = await registerUser(testApp);
    const failingClose: UserAdminContext = {
      ...contextOf(testApp),
      close: () => Promise.reject(new Error('audit flush failed')),
    };
    const result = await runCli(testApp, ['grant-admin', '--username', user.username], {
      openContext: () => Promise.resolve(failingClose),
    });
    expect(result.code).toBe(1);
    expect(JSON.parse(result.stdout)).toMatchObject({ ok: true, op: 'grant-admin', role: 'admin' });
    expect(result.stderr).toContain('shutdown failed: the outcome reported above stands');
    expect((await userRow(testApp, user.username)).role).toBe('admin');
  });
});

describe('grant-admin / revoke-admin (section 6.2: requireRole reads the database)', () => {
  it('apply on the next request with the SAME access token, without revoking sessions', async () => {
    const user = await registerUser(testApp);
    expect((await adminOnly(user.auth.accessToken)).statusCode).toBe(403);

    const granted = await runCli(testApp, ['grant-admin', '--username', user.username.toUpperCase()]);
    expect(granted.code).toBe(0);
    expect(JSON.parse(granted.stdout)).toMatchObject({
      ok: true,
      op: 'grant-admin',
      userId: user.auth.user.id,
      role: 'admin',
      revokedSessions: 0,
    });
    const allowed = await adminOnly(user.auth.accessToken);
    expect(allowed.statusCode).toBe(200);
    expect(allowed.json()).toEqual({ ok: true });

    const revoked = await runCli(testApp, ['revoke-admin', '--username', user.username]);
    expect(revoked.code).toBe(0);
    const denied = await adminOnly(user.auth.accessToken);
    expect(denied.statusCode).toBe(403);
    expect(problem(denied).code).toBe('FORBIDDEN');

    expect((await sessionRow(testApp, user.auth.sessionId)).revoked_at).toBeNull();
    const rows = auditEvents(testApp, 'admin.user_update').filter(
      (event) => event.targetId === user.auth.user.id,
    );
    expect(rows).toEqual([
      expect.objectContaining({
        outcome: 'success',
        actorId: null,
        targetType: 'user',
        details: { op: 'grant-admin', operator: OPERATOR },
      }),
      expect.objectContaining({ outcome: 'success', details: { op: 'revoke-admin', operator: OPERATOR } }),
    ]);
  });
});

describe('disable / enable (section 6.2)', () => {
  it('disable revokes every session (admin), marks them in Redis, publishes one event each, blocks login', async () => {
    const user = await registerUser(testApp);
    const second = await loginSession(testApp, user.username, PASSWORD);
    const sessionIds = [user.auth.sessionId, second.auth.sessionId];
    const eventsBefore = sessionEvents(testApp).length;

    const result = await runCli(testApp, ['disable', '--username', user.username]);
    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      ok: true,
      op: 'disable',
      disabled: true,
      revokedSessions: 2,
      deliveredSessions: 2,
      redisFailures: [],
    });

    for (const sessionId of sessionIds) {
      expect((await sessionRow(testApp, sessionId)).revoked_reason).toBe('admin');
      expect(await testApp.container.revocations.isRevoked(sessionId)).toBe(true);
    }
    const events = sessionEvents(testApp).slice(eventsBefore);
    expect(events).toHaveLength(2);
    expect(events).toEqual(
      expect.arrayContaining(
        sessionIds.map((sessionId) => ({
          kind: 'revoked',
          sessionId,
          userId: user.auth.user.id,
          reason: 'admin',
        })),
      ),
    );

    const oldToken = await authed(testApp, 'GET', '/api/v1/auth/me', user.auth.accessToken);
    expect(oldToken.statusCode).toBe(401);
    expect(problem(oldToken).code).toBe('SESSION_REVOKED');
    const blocked = await login(testApp, user.username, PASSWORD);
    expect(blocked.statusCode).toBe(403);
    expect(problem(blocked).code).toBe('ACCOUNT_DISABLED');
    expect(auditEvents(testApp, 'admin.user_update')).toContainEqual(
      expect.objectContaining({
        outcome: 'success',
        targetId: user.auth.user.id,
        details: { op: 'disable', operator: OPERATOR, revokedSessions: 2 },
      }),
    );

    const enabled = await runCli(testApp, ['enable', '--username', user.username]);
    expect(enabled.code).toBe(0);
    expect(JSON.parse(enabled.stdout)).toMatchObject({ ok: true, op: 'enable', disabled: false });
    expect((await userRow(testApp, user.username)).disabled_at).toBeNull();
    const again = await loginSession(testApp, user.username, PASSWORD);
    expect((await authed(testApp, 'GET', '/api/v1/auth/me', again.auth.accessToken)).statusCode).toBe(200);
  });

  it('disable with Redis unreachable: exit 1 naming the failed steps; the DB change stands; a re-run delivers', async () => {
    const proxy = await createTcpProxy(process.env['REDIS_URL'] ?? '');
    // The real RedisEventBus: its publish resolves false while Redis is unreachable.
    const degraded = await createAuthTestApp({ config: { REDIS_URL: proxy.url }, redisBus: true });
    try {
      const user = await registerUser(degraded);
      const second = await loginSession(degraded, user.username, PASSWORD);
      const sessionIds = [user.auth.sessionId, second.auth.sessionId];

      proxy.pause();
      await waitFor(() => degraded.container.redis.cmd.status !== 'ready');
      const failed = await runCli(degraded, ['disable', '--username', user.username]);
      expect(failed.code).toBe(1);
      expect(failed.stderr).toContain('the database change is committed and final');
      for (const sessionId of sessionIds) {
        expect(failed.stderr).toContain(`revocations.markRevoked(${sessionId}) failed`);
        expect(failed.stderr).toContain(`events.publish('sessions', ${sessionId}) failed`);
      }
      expect(JSON.parse(failed.stdout)).toMatchObject({ ok: false, revokedSessions: 2 });

      expect((await userRow(degraded, user.username)).disabled_at).not.toBeNull();
      for (const sessionId of sessionIds) {
        expect((await sessionRow(degraded, sessionId)).revoked_reason).toBe('admin');
      }
      expect(auditEvents(degraded, 'admin.user_update')).toContainEqual(
        expect.objectContaining({
          outcome: 'failure',
          details: { op: 'disable', operator: OPERATOR, revokedSessions: 2, redisFailures: 4 },
        }),
      );

      // Once Redis is back, re-running the same command delivers the missing marks and events (idempotent).
      proxy.resume();
      await waitFor(() => degraded.container.redis.cmd.status === 'ready', { timeoutMs: 10_000 });
      const retried = await runCli(degraded, ['disable', '--username', user.username]);
      expect(retried.code).toBe(0);
      expect(JSON.parse(retried.stdout)).toMatchObject({
        ok: true,
        revokedSessions: 0,
        deliveredSessions: 2,
        redisFailures: [],
      });
      for (const sessionId of sessionIds) {
        expect(await degraded.container.revocations.isRevoked(sessionId)).toBe(true);
      }
    } finally {
      await degraded.close();
      await proxy.close();
    }
  });
});
