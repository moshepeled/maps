/**
 * Shared helpers of the auth integration suites (SPEC section 12.3 `auth/*`): an app with only the auth module (plus optional
 * test routes), in-memory audit and bus overrides so outcomes can be asserted exactly, request shortcuts for the auth
 * endpoints, refresh-cookie parsing, fixture SQL for session timestamps (to simulate elapsed time without sleeping) and
 * a held row lock for the login/disable race.
 */
import { AuthResponseSchema, ProblemSchema } from '@snapland/shared';
import type { AuthResponse, Problem } from '@snapland/shared';
import type { LightMyRequestResponse as InjectResponse } from 'fastify';
import { pino } from 'pino';

import type { InMemoryAuditLogger } from '../../../src/infra/audit/in-memory.js';
import type { NormalizedAuditEvent } from '../../../src/infra/audit/normalize.js';
import type { AuditAction } from '../../../src/infra/audit/types.js';
import { systemClock } from '../../../src/infra/clock.js';
import { sql } from '../../../src/infra/db/types.js';
import { InMemoryEventBus } from '../../../src/infra/events/in-memory.js';
import type { BusPayload } from '../../../src/infra/events/types.js';
import { createAuthModule } from '../../../src/modules/auth/index.js';
import { loginFailureKeys } from '../../../src/modules/auth/login-failures.js';
import type { LoginFailureKeys } from '../../../src/modules/auth/login-failures.js';
import { REFRESH_COOKIE_NAME } from '../../../src/modules/auth/refresh-tokens.js';
import { canonicalUsername } from '../../../src/modules/auth/username.js';
import { createMemoryAudit } from '../../helpers/audit.js';
import { uniqueIp } from '../../helpers/net.js';
import { createTestApp } from '../../helpers/test-app.js';
import type { TestApp, TestAppOptions } from '../../helpers/test-app.js';
import { DISABLE_USER, bearer, nextUsername } from '../../helpers/users.js';

export const PASSWORD = 'correct-horse-battery';

export interface AuthTestApp extends TestApp {
  audit: InMemoryAuditLogger;
  /** Present when the app was built with the in-memory bus (the default). */
  bus: InMemoryEventBus | null;
}

export interface AuthTestAppOptions extends Omit<TestAppOptions, 'modules' | 'overrides'> {
  /** Keep the real RedisEventBus (outage tests) instead of the in-memory bus. */
  redisBus?: boolean;
}

/** The auth module alone, with an in-memory audit and bus so every outcome can be asserted exactly (section 3.3). */
export async function createAuthTestApp(options: AuthTestAppOptions = {}): Promise<AuthTestApp> {
  const audit = createMemoryAudit();
  const bus =
    options.redisBus === true
      ? null
      : new InMemoryEventBus({
          instanceId: 'auth-it',
          clock: systemClock,
          logger: pino({ level: 'silent' }),
        });
  const { redisBus: _redisBus, ...testAppOptions } = options;
  const testApp = await createTestApp({
    ...testAppOptions,
    modules: [createAuthModule],
    overrides: { audit, ...(bus === null ? {} : { events: bus }) },
  });
  return Object.assign(testApp, { audit, bus });
}

export interface RequestOptions {
  ip?: string;
  headers?: Record<string, string>;
}

export function register(
  testApp: TestApp,
  body: Record<string, unknown>,
  { ip = uniqueIp(), headers = {} }: RequestOptions = {},
): Promise<InjectResponse> {
  return testApp.app.inject({
    method: 'POST',
    url: '/api/v1/auth/register',
    payload: body,
    remoteAddress: ip,
    headers,
  });
}

export function login(
  testApp: TestApp,
  username: string,
  password: string,
  { ip = uniqueIp(), headers = {} }: RequestOptions = {},
): Promise<InjectResponse> {
  return testApp.app.inject({
    method: 'POST',
    url: '/api/v1/auth/login',
    payload: { username, password },
    remoteAddress: ip,
    headers,
  });
}

export function refresh(
  testApp: TestApp,
  refreshToken: string | undefined,
  { ip = uniqueIp(), headers = {} }: RequestOptions = {},
): Promise<InjectResponse> {
  return testApp.app.inject({
    method: 'POST',
    url: '/api/v1/auth/refresh',
    remoteAddress: ip,
    headers,
    ...(refreshToken === undefined ? {} : { cookies: { [REFRESH_COOKIE_NAME]: refreshToken } }),
  });
}

export function authed(
  testApp: TestApp,
  method: 'GET' | 'POST' | 'DELETE',
  url: string,
  accessToken: string,
  { ip = uniqueIp(), headers = {} }: RequestOptions = {},
): Promise<InjectResponse> {
  return testApp.app.inject({
    method,
    url,
    remoteAddress: ip,
    headers: { ...headers, ...bearer({ accessToken }) },
  });
}

export function authBody(response: InjectResponse): AuthResponse {
  return AuthResponseSchema.parse(response.json());
}

export function problem(response: InjectResponse): Problem {
  return ProblemSchema.parse(response.json());
}

/** The `snap_rt` cookie a response set (throws when there is none). */
export function refreshCookie(response: InjectResponse): InjectResponse['cookies'][number] {
  const cookie = response.cookies.find((candidate) => candidate.name === REFRESH_COOKIE_NAME);
  if (cookie === undefined) throw new Error(`no ${REFRESH_COOKIE_NAME} cookie in the response`);
  return cookie;
}

/** The raw Set-Cookie header of `snap_rt` (attribute assertions). */
export function rawRefreshCookie(response: InjectResponse): string {
  const header = response.headers['set-cookie'];
  const values = Array.isArray(header) ? header : header === undefined ? [] : [header];
  const found = values.find((value) => value.startsWith(`${REFRESH_COOKIE_NAME}=`));
  if (found === undefined) throw new Error(`no ${REFRESH_COOKIE_NAME} Set-Cookie header`);
  return found;
}

/** The two login failure counter keys of (username, IP), derived exactly as the service derives them. */
export function failureCounterKeys(testApp: TestApp, username: string, ip: string | null): LoginFailureKeys {
  const name = canonicalUsername(username);
  if (name === null)
    throw new Error(`${JSON.stringify(username)} cannot name an account, so it has no counters`);
  return loginFailureKeys(testApp.container.keys, name, ip);
}

/** How many of the given Redis keys exist. */
export function existingKeyCount(testApp: TestApp, keys: LoginFailureKeys): Promise<number> {
  return testApp.container.redis.cmd.exists(keys.userIp, keys.user);
}

/** A registered user with a live session (through the real endpoint). */
export interface RegisteredUser {
  username: string;
  password: string;
  auth: AuthResponse;
  refreshToken: string;
}

export async function registerUser(
  testApp: TestApp,
  overrides: { username?: string; displayName?: string; ip?: string } = {},
): Promise<RegisteredUser> {
  const username = overrides.username ?? nextUsername();
  const response = await register(
    testApp,
    { username, password: PASSWORD, displayName: overrides.displayName ?? `User ${username.slice(-6)}` },
    { ip: overrides.ip ?? uniqueIp() },
  );
  if (response.statusCode !== 201)
    throw new Error(`register failed: ${response.statusCode} ${response.body}`);
  return {
    username,
    password: PASSWORD,
    auth: authBody(response),
    refreshToken: refreshCookie(response).value,
  };
}

/** A fresh session of an existing user (through the real login endpoint). */
export async function loginSession(
  testApp: TestApp,
  username: string,
  password = PASSWORD,
  options: RequestOptions = {},
): Promise<{ auth: AuthResponse; refreshToken: string }> {
  const response = await login(testApp, username, password, options);
  if (response.statusCode !== 200) throw new Error(`login failed: ${response.statusCode} ${response.body}`);
  return { auth: authBody(response), refreshToken: refreshCookie(response).value };
}

export function auditEvents(testApp: AuthTestApp, action: AuditAction): NormalizedAuditEvent[] {
  return testApp.audit.find((event) => event.action === action);
}

/** Audit events of one request (the hook and the service both tag events with the request id). */
export function auditEventsOf(testApp: AuthTestApp, response: InjectResponse): NormalizedAuditEvent[] {
  const requestId = response.headers['x-request-id'];
  return testApp.audit.find((event) => event.requestId === requestId);
}

export function sessionEvents(testApp: AuthTestApp): BusPayload<'sessions'>[] {
  if (testApp.bus === null) throw new Error('the app uses the Redis bus');
  return testApp.bus.publishedOn('sessions');
}

// ---- fixture SQL (test-only; simulates elapsed time and inspects rows the API does not expose) ----

const SESSION_ROW = sql(
  'authIt.sessionRow',
  `SELECT id, user_id, revoked_at, revoked_reason, rotated_at, expires_at, absolute_expires_at, user_agent,
          refresh_token_hash, previous_token_hash, now() AS db_now
     FROM sessions WHERE id = $1::uuid`,
);
const BACKDATE_ROTATION = sql(
  'authIt.backdateRotation',
  'UPDATE sessions SET rotated_at = rotated_at - make_interval(secs => $2) WHERE id = $1::uuid',
);
const SET_EXPIRY = sql(
  'authIt.setExpiry',
  `UPDATE sessions
      SET expires_at = now() + make_interval(secs => $2), absolute_expires_at = now() + make_interval(secs => $3)
    WHERE id = $1::uuid`,
);
const USER_ROW = sql(
  'authIt.userRow',
  'SELECT id, role, disabled_at FROM users WHERE lower(username) = lower($1)',
);
const SET_ROLE = sql('authIt.setRole', 'UPDATE users SET role = $2 WHERE id = $1::uuid');
const SESSION_IDS_OF_USER = sql(
  'authIt.sessionIdsOfUser',
  'SELECT id FROM sessions WHERE user_id = $1::uuid ORDER BY created_at, id',
);
const BACKEND_PID = sql('authIt.backendPid', 'SELECT pg_backend_pid() AS pid');
/** Backends waiting for a lock held by the given backend (exactly the statements our fixture transaction blocks). */
const BLOCKED_BY = sql(
  'authIt.blockedBy',
  'SELECT count(*)::int AS waiting FROM pg_stat_activity WHERE $1::int = ANY(pg_blocking_pids(pid))',
);

export interface SessionRow {
  id: string;
  user_id: string;
  revoked_at: Date | null;
  revoked_reason: string | null;
  rotated_at: Date | null;
  expires_at: Date;
  absolute_expires_at: Date;
  user_agent: string | null;
  refresh_token_hash: Buffer;
  previous_token_hash: Buffer | null;
  db_now: Date;
}

export async function sessionRow(testApp: TestApp, sessionId: string): Promise<SessionRow> {
  const [row] = await testApp.container.db.query<SessionRow & Record<string, unknown>>(SESSION_ROW, [
    sessionId,
  ]);
  if (row === undefined) throw new Error(`no session ${sessionId}`);
  return row;
}

export async function backdateRotation(testApp: TestApp, sessionId: string, seconds: number): Promise<void> {
  await testApp.container.db.query(BACKDATE_ROTATION, [sessionId, seconds]);
}

/** Sets both expiries relative to now (negative = in the past); `expiresInS` must not exceed `absoluteInS`. */
export async function setSessionExpiry(
  testApp: TestApp,
  sessionId: string,
  expiresInS: number,
  absoluteInS: number,
): Promise<void> {
  await testApp.container.db.query(SET_EXPIRY, [sessionId, expiresInS, absoluteInS]);
}

export async function userRow(
  testApp: TestApp,
  username: string,
): Promise<{ id: string; role: string; disabled_at: Date | null }> {
  const [row] = await testApp.container.db.query<{ id: string; role: string; disabled_at: Date | null }>(
    USER_ROW,
    [username],
  );
  if (row === undefined) throw new Error(`no user ${username}`);
  return row;
}

export async function setRole(testApp: TestApp, userId: string, role: 'user' | 'admin'): Promise<void> {
  await testApp.container.db.query(SET_ROLE, [userId, role]);
}

export async function sessionIdsOfUser(testApp: TestApp, userId: string): Promise<string[]> {
  const rows = await testApp.container.db.query<{ id: string }>(SESSION_IDS_OF_USER, [userId]);
  return rows.map((row) => row.id);
}

/**
 * The login/disable race fixture: disables the user in a transaction that stays open - holding the user row lock, like
 * the CLI's `disable` between its UPDATE and its commit - until `during` resolves, then commits. `during` gets a probe
 * that is true once another backend waits for that lock.
 */
export async function whileDisablingUser<T>(
  testApp: TestApp,
  userId: string,
  during: (anotherBackendWaits: () => Promise<boolean>) => Promise<T>,
): Promise<T> {
  const { db } = testApp.container;
  return db.withTransaction(async (tx) => {
    const [self] = await tx.query<{ pid: number }>(BACKEND_PID);
    if (self === undefined) throw new Error('pg_backend_pid() returned no row');
    await tx.query(DISABLE_USER, [userId]);
    const anotherBackendWaits = async (): Promise<boolean> => {
      const [row] = await db.query<{ waiting: number }>(BLOCKED_BY, [self.pid]);
      return (row?.waiting ?? 0) > 0;
    };
    return during(anotherBackendWaits);
  });
}
