/**
 * SQL-injection battery (QA sweep C). Classic and PostgreSQL-specific injection payloads go into EVERY input that can
 * reach SQL - REST bodies, query strings, path params, headers and cookies, WebSocket frames (plus the ticket claims
 * read back from Redis) and the operator CLIs - against a fully wired app (every module; the production Redis draw
 * limiter, bus and buffered audit writer) on the run's throwaway database.
 *
 * Contract of every probe: a 2xx that stores and returns the payload as DATA (text fields: exactly the shared
 * sanitiser's output), or a 4xx - never a 5xx, never a reply slower than MAX_REPLY_MS (an injected `pg_sleep(5)` would
 * exceed it), and afterwards users/sessions/areas/area_versions still exist holding exactly the baseline plus the rows
 * the API reported creating. Each test collects its violations and prints them with the exact payload and response.
 */
import { randomBytes, randomUUID } from 'node:crypto';

import { LIMITS, quantize, sanitizeText } from '@snapland/shared';
import type {
  AreaDto,
  AreaListResponse,
  AreaMutationResponse,
  AreaVersionListResponse,
  AuditLogListResponse,
  AuthResponse,
  PolygonCoordinates,
  SessionListResponse,
} from '@snapland/shared';
import type { InjectOptions, LightMyRequestResponse } from 'fastify';
import { pino } from 'pino';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { sql } from '../../../src/infra/db/types.js';
import { normalizeUserAgent } from '../../../src/infra/http/request-context.js';
import { filtersFingerprint } from '../../../src/modules/admin/audit-cursor.js';
import { queryBinding } from '../../../src/modules/areas/cursor.js';
import { REFRESH_COOKIE_NAME } from '../../../src/modules/auth/refresh-tokens.js';
import { canonicalUsername } from '../../../src/modules/auth/username.js';
import { run as runSeed } from '../../../src/scripts/seed.js';
import { run as runUserAdmin } from '../../../src/scripts/user-admin.js';
import type { UserAdminContext } from '../../../src/scripts/user-admin.js';
import { uniqueIp } from '../../helpers/net.js';
import { createTestApp } from '../../helpers/test-app.js';
import type { TestApp } from '../../helpers/test-app.js';
import { bearer, createUser } from '../../helpers/users.js';
import type { TestUser } from '../../helpers/users.js';
import { waitFor } from '../../helpers/wait-for.js';
import { handshakeStatus, issueTicket, openClient } from '../realtime/realtime-harness.js';
import type { ServerMessage, WsClient } from '../realtime/realtime-harness.js';

/**
 * Any reply slower than this is a finding: every payload below that reached SQL as code would sleep 5 s (or hit the
 * 5 s statement timeout). 4 s, not 2 s: an argon2id login during a full integration run once took 2015 ms.
 */
const MAX_REPLY_MS = 4000;
const PASSWORD = 'sqli-battery-password';
const NUL = String.fromCodePoint(0);

/** Classic, PostgreSQL-specific and encoding-trick payloads (each also a plausible piece of text). */
const PAYLOADS: readonly string[] = [
  "' OR '1'='1",
  "' OR 1=1 --",
  "admin'--",
  "'; DROP TABLE users; --",
  '"; DROP TABLE areas; --',
  "'); DELETE FROM areas; --",
  '1; SELECT pg_sleep(5)',
  "'; SELECT pg_sleep(5); --",
  "1' AND (SELECT 1 FROM pg_sleep(5)) IS NULL --",
  "'||(SELECT pg_sleep(5))::text||'",
  "' UNION SELECT id::text, password_hash FROM users --",
  "'; COPY users TO PROGRAM 'id'; --",
  '\\x27',
  "\\'; DROP TABLE sessions; --",
  "E'\\x27 OR 1=1 --",
  '$$ OR 1=1 $$',
  '$q$; DROP TABLE users; $q$',
  '*/ OR 1=1 /*',
  "'::uuid; --",
  '’ OR ‘1’=‘1', // curly quotes
  '＇ OR 1=1 --', // fullwidth apostrophe
  'ʼ; DROP TABLE users; --', // modifier letter apostrophe
  `a${NUL}'; DROP TABLE users; --`, // NUL byte
  '{"type":"Polygon","coordinates":"\'; DROP TABLE areas; --"}', // JSON in a string
  '{"$ne": null}',
  '%27%20OR%201%3D1--',
  "'".repeat(300),
  `${'A'.repeat(5000)}'; DROP TABLE users; --`, // very long
];

/** The payloads a real HTTP client can put in a header value (printable Latin-1: no NUL, nothing above U+00FF). */
const HEADER_PAYLOADS = PAYLOADS.filter((payload) => /^[\x20-\x7e\xa0-\xff]*$/.test(payload));

// -- Fixture SQL (test-only; reads what the API does not expose) ----------------------------------------------

const TABLES_PRESENT = sql(
  'sqliIt.tablesPresent',
  `SELECT to_regclass('public.users') IS NOT NULL AND to_regclass('public.sessions') IS NOT NULL
      AND to_regclass('public.areas') IS NOT NULL AND to_regclass('public.area_versions') IS NOT NULL
      AND to_regclass('public.audit_logs') IS NOT NULL AS present`,
);
const TABLE_COUNTS = sql(
  'sqliIt.tableCounts',
  `SELECT (SELECT count(*) FROM users)::int AS users,
          (SELECT count(*) FROM users WHERE role = 'admin')::int AS admins,
          (SELECT count(*) FROM sessions)::int AS sessions,
          (SELECT count(*) FROM areas)::int AS areas,
          (SELECT count(*) FROM area_versions)::int AS versions`,
);
const AREA_TEXT = sql('sqliIt.areaText', 'SELECT name, description FROM areas WHERE id = $1::uuid');
const USER_ROW = sql(
  'sqliIt.userRow',
  'SELECT username, display_name, role, disabled_at FROM users WHERE id = $1::uuid',
);
const AUDIT_USER_AGENT = sql(
  'sqliIt.auditUserAgent',
  'SELECT user_agent FROM audit_logs WHERE request_id = $1 ORDER BY id LIMIT 1',
);
const AUDIT_TARGET_ID = sql(
  'sqliIt.auditTargetId',
  'SELECT target_id FROM audit_logs WHERE request_id = $1 ORDER BY id LIMIT 1',
);
const ACTIVE_SLEEPS = sql(
  'sqliIt.activeSleeps',
  `SELECT count(*)::int AS n FROM pg_stat_activity
    WHERE datname = current_database() AND pid <> pg_backend_pid() AND state = 'active' AND query ILIKE '%pg_sleep%'`,
);

interface TableCounts {
  users: number;
  admins: number;
  sessions: number;
  areas: number;
  versions: number;
}

let testApp: TestApp;
let admin: TestUser;
let alice: TestUser;
let baseline: TableCounts;
/** Rows the API reported creating (201 register/area, 200 login, non-noop writes): the tables must hold exactly these. */
const created: TableCounts = { users: 0, admins: 0, sessions: 0, areas: 0, versions: 0 };
/** A live area whose name is an injection payload (history, lock and admin probes). */
let payloadAreaId = '';

beforeAll(async () => {
  testApp = await createTestApp({
    config: { DRAW_RATE_LIMIT_MAX: 100_000, AUDIT_FLUSH_INTERVAL_MS: 50, WS_MAX_CONNECTIONS_PER_USER: 100 },
  });
  baseline = await tableCounts();
  [admin, alice] = await Promise.all([
    createUser(testApp.container, { role: 'admin', displayName: 'SQLi admin' }),
    createUser(testApp.container, { displayName: 'SQLi alice' }),
  ]);
  created.users += 2;
  created.admins += 1;
  created.sessions += 2;
});

afterAll(async () => {
  await testApp.close();
});

// -- Helpers --------------------------------------------------------------------------------------------------

async function tableCounts(): Promise<TableCounts> {
  const [row] = await testApp.container.db.query<TableCounts & Record<string, unknown>>(TABLE_COUNTS);
  if (row === undefined) throw new Error('table counts returned no row');
  return row;
}

/** The tables still exist and hold exactly the baseline plus what the API reported creating. */
async function assertIntact(): Promise<void> {
  const [row] = await testApp.container.db.query<{ present: boolean }>(TABLES_PRESENT);
  expect(row?.present, 'users, sessions, areas, area_versions and audit_logs must still exist').toBe(true);
  expect(await tableCounts()).toEqual({
    users: baseline.users + created.users,
    admins: baseline.admins + created.admins,
    sessions: baseline.sessions + created.sessions,
    areas: baseline.areas + created.areas,
    versions: baseline.versions + created.versions,
  });
}

interface Probe {
  response: LightMyRequestResponse;
  ms: number;
}

async function send(options: InjectOptions): Promise<Probe> {
  const started = performance.now();
  const response = await testApp.app.inject(options);
  return { response, ms: performance.now() - started };
}

function asUser(user: { accessToken: string }, options: InjectOptions): Promise<Probe> {
  return send({ ...options, headers: { ...options.headers, ...bearer(user) } });
}

const enc = encodeURIComponent;

function show(value: string): string {
  const json = JSON.stringify(value);
  return json.length <= 90 ? json : `${json.slice(0, 80)}… (${value.length} chars)`;
}

/** Records a violation unless the probe answered one of `allowed` in time. */
function expectStatus(
  problems: string[],
  where: string,
  payload: string,
  { response, ms }: Probe,
  allowed: readonly number[],
): void {
  if (allowed.includes(response.statusCode) && ms < MAX_REPLY_MS) return;
  problems.push(
    `${where} ${show(payload)} → HTTP ${response.statusCode} in ${Math.round(ms)} ms ` +
      `(expected ${allowed.join('/')} < ${MAX_REPLY_MS} ms): ${response.body.slice(0, 240)}`,
  );
}

function expectNoProblems(problems: string[]): void {
  expect(problems, `\n${problems.join('\n')}`).toEqual([]);
}

type Expected = { accepted: true; value: string | null } | { accepted: false };

/** What the service stores for a raw text value: the sanitiser's output ('' -> null), or a refusal (400). */
function expectedText(raw: string, rawMax: number, options: Parameters<typeof sanitizeText>[1]): Expected {
  if (raw.length > rawMax) return { accepted: false };
  const result = sanitizeText(raw, options);
  if (!result.ok) return { accepted: false };
  return { accepted: true, value: result.value === '' ? null : result.value };
}

const NAME_RULES = { maxLength: LIMITS.nameMaxLength };
const DESCRIPTION_RULES = { maxLength: LIMITS.descriptionMaxLength, multiline: true, allowEmpty: true };

function freshUsername(): string {
  return `sq${randomBytes(6).toString('hex')}`;
}

async function register(body: Record<string, unknown>): Promise<Probe> {
  const probe = await send({
    method: 'POST',
    url: '/api/v1/auth/register',
    remoteAddress: uniqueIp(),
    payload: body,
  });
  if (probe.response.statusCode === 201) {
    created.users += 1;
    created.sessions += 1;
  }
  return probe;
}

async function login(username: string, password: string, extra: Partial<InjectOptions> = {}): Promise<Probe> {
  const probe = await send({
    method: 'POST',
    url: '/api/v1/auth/login',
    remoteAddress: uniqueIp(),
    ...extra,
    payload: { username, password },
  });
  if (probe.response.statusCode === 200) created.sessions += 1;
  return probe;
}

/** A unique ~50 m square near Jerusalem, quantised like stored geometry (this file's areas never overlap others). */
let squareCounter = 0;
function square(): { type: 'Polygon'; coordinates: PolygonCoordinates } {
  squareCounter += 1;
  const west = quantize(35.2 + (squareCounter % 300) * 0.0006, 7);
  const south = quantize(31.7 + Math.floor(squareCounter / 300) * 0.0006, 7);
  const east = quantize(west + 0.0005, 7);
  const north = quantize(south + 0.0005, 7);
  return {
    type: 'Polygon',
    coordinates: [
      [
        [west, south],
        [east, south],
        [east, north],
        [west, north],
        [west, south],
      ],
    ],
  };
}

/** The squares' region as a bbox parameter (inside the pixel span cap at zoom 15). */
const LIST_BBOX = '35.19,31.69,35.4,31.72';

async function createArea(body: Record<string, unknown>): Promise<Probe> {
  const probe = await asUser(alice, { method: 'POST', url: '/api/v1/areas', payload: body });
  if (probe.response.statusCode === 201) {
    created.areas += 1;
    created.versions += 1;
  }
  return probe;
}

/** PATCH / DELETE / restore as alice; a non-noop 200 appends one version. */
async function writeArea(options: InjectOptions): Promise<Probe> {
  const probe = await asUser(alice, options);
  if (probe.response.statusCode === 200 && !probe.response.json<AreaMutationResponse>().noop) {
    created.versions += 1;
  }
  return probe;
}

async function areaText(id: string): Promise<{ name: string; description: string | null } | undefined> {
  const [row] = await testApp.container.db.query<{ name: string; description: string | null }>(AREA_TEXT, [
    id,
  ]);
  return row;
}

function b64url(value: unknown): string {
  return Buffer.from(typeof value === 'string' ? value : JSON.stringify(value), 'utf8').toString('base64url');
}

/** The token with its claims replaced but the ORIGINAL signature kept (tampering). */
function tamperedToken(token: string, patch: Record<string, unknown>): string {
  const [header = '', body = '', signature = ''] = token.split('.');
  const claims = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as Record<string, unknown>;
  return `${header}.${b64url({ ...claims, ...patch })}.${signature}`;
}

/** An unsigned (`alg: none`) token with the given claim patch. */
function unsignedToken(token: string, patch: Record<string, unknown>): string {
  const [, body = ''] = token.split('.');
  const claims = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as Record<string, unknown>;
  return `${b64url({ alg: 'none', typ: 'JWT' })}.${b64url({ ...claims, ...patch })}.`;
}

// -- REST: auth -----------------------------------------------------------------------------------------------

describe('REST auth inputs', () => {
  it('register: SQL in the username is refused by the handle/email pattern (400)', async () => {
    const problems: string[] = [];
    for (const payload of PAYLOADS) {
      const probe = await register({ username: payload, password: PASSWORD, displayName: 'SQLi probe' });
      expectStatus(problems, 'POST /auth/register body.username', payload, probe, [400]);
    }
    expectNoProblems(problems);
    await assertIntact();
  });

  it('register/login: allowed usernames with SQL-significant characters (-- _ % +) are exact data, never LIKE patterns', async () => {
    const suffix = randomBytes(4).toString('hex');
    const handle = `o--r.1_${suffix}`; // "--" starts a SQL comment, "_" is a LIKE wildcard
    const email = `x%27or+1_${suffix}@ex-ample.io`; // "%" is a LIKE wildcard, "%27" a URL-encoded quote
    for (const username of [handle, email]) {
      const probe = await register({ username, password: PASSWORD, displayName: 'SQLi wildcard' });
      expect(probe.response.statusCode, probe.response.body).toBe(201);
      const { user } = probe.response.json<AuthResponse>();
      expect(user.username).toBe(username);
      const [row] = await testApp.container.db.query<{ username: string }>(USER_ROW, [user.id]);
      expect(row?.username).toBe(username);
      // Case-insensitive exact match still signs in.
      expect((await login(username.toUpperCase(), PASSWORD)).response.statusCode).toBe(200);
    }
    // Look-alikes that pass the pattern (so they DO reach `lower(username) = $1`) and would match under LIKE.
    const lookalikes = [
      `_${handle.slice(1)}`,
      `${handle.slice(0, -1)}_`,
      `%${email.slice(1)}`,
      `x%@ex-ample.io`,
    ];
    const problems: string[] = [];
    for (const lookalike of lookalikes) {
      expect(canonicalUsername(lookalike), `${lookalike} must reach SQL`).not.toBeNull();
      expectStatus(
        problems,
        'POST /auth/login body.username',
        lookalike,
        await login(lookalike, PASSWORD),
        [401],
      );
    }
    expectNoProblems(problems);
    await assertIntact();
  });

  it('register: SQL in displayName is stored and returned verbatim (sanitised), or 400', async () => {
    const problems: string[] = [];
    for (const payload of PAYLOADS) {
      const expected = expectedText(payload, LIMITS.displayNameRawMaxLength, {
        maxLength: LIMITS.displayNameMaxLength,
      });
      const probe = await register({ username: freshUsername(), password: PASSWORD, displayName: payload });
      const where = 'POST /auth/register body.displayName';
      if (!expected.accepted) {
        expectStatus(problems, where, payload, probe, [400]);
        continue;
      }
      expectStatus(problems, where, payload, probe, [201]);
      if (probe.response.statusCode !== 201) continue;
      const { user } = probe.response.json<AuthResponse>();
      const [row] = await testApp.container.db.query<{ display_name: string }>(USER_ROW, [user.id]);
      if (user.displayName !== expected.value || row?.display_name !== expected.value) {
        problems.push(
          `${where} ${show(payload)}: returned ${show(user.displayName)}, stored ${show(row?.display_name ?? '<none>')}, ` +
            `expected ${show(expected.value ?? '')}`,
        );
      }
    }
    expectNoProblems(problems);
    await assertIntact();
  }, 120_000);

  it('register + login: SQL in the password is only ever hashed data', async () => {
    const problems: string[] = [];
    const passwords = PAYLOADS.filter(
      (payload) => payload.length >= LIMITS.passwordMinLength && payload.length <= LIMITS.passwordMaxLength,
    );
    expect(passwords.length).toBeGreaterThan(15);
    for (const payload of passwords) {
      const username = freshUsername();
      const where = 'password';
      expectStatus(
        problems,
        `register ${where}`,
        payload,
        await register({ username, password: payload, displayName: 'SQLi pw' }),
        [201],
      );
      expectStatus(problems, `login (right) ${where}`, payload, await login(username, payload), [200]);
      const wrong = payload === "' OR '1'='1" ? "' OR 1=1 --" : "' OR '1'='1";
      expectStatus(problems, `login (wrong) ${where}`, wrong, await login(username, wrong), [401]);
    }
    expectNoProblems(problems);
    await assertIntact();
  }, 120_000);

  it('login: SQL in the username or the password -> 401 (400 over the length cap), never a session', async () => {
    const victim = freshUsername();
    expect(
      (await register({ username: victim, password: PASSWORD, displayName: 'SQLi victim' })).response
        .statusCode,
    ).toBe(201);
    const problems: string[] = [];
    for (const payload of PAYLOADS) {
      expectStatus(
        problems,
        'POST /auth/login body.username',
        payload,
        await login(payload, PASSWORD),
        [400, 401],
      );
      // 429: the per-account failure lock may engage - still a refusal.
      expectStatus(
        problems,
        'POST /auth/login body.password',
        payload,
        await login(victim, payload),
        [400, 401, 429],
      );
    }
    expectNoProblems(problems);
    await assertIntact();
  }, 120_000);

  it('refresh: SQL in the snap_rt cookie -> 401', async () => {
    const problems: string[] = [];
    for (const payload of PAYLOADS) {
      const probe = await send({
        method: 'POST',
        url: '/api/v1/auth/refresh',
        remoteAddress: uniqueIp(),
        headers: { cookie: `${REFRESH_COOKIE_NAME}=${enc(payload)}` },
      });
      expectStatus(problems, 'POST /auth/refresh cookie snap_rt', payload, probe, [401]);
    }
    expectNoProblems(problems);
    await assertIntact();
  });

  it('bearer: SQL as the token, tampered/unsigned tokens and even validly signed SQL claims -> 401', async () => {
    const problems: string[] = [];
    const me: InjectOptions = { method: 'GET', url: '/api/v1/auth/me' };
    for (const payload of HEADER_PAYLOADS) {
      expectStatus(
        problems,
        'Authorization: Bearer',
        payload,
        await asUser({ accessToken: payload }, me),
        [401],
      );
    }
    for (const payload of PAYLOADS) {
      for (const claim of ['sid', 'sub'] as const) {
        const tampered = tamperedToken(alice.accessToken, { [claim]: payload });
        expectStatus(
          problems,
          `tampered JWT ${claim}`,
          payload,
          await asUser({ accessToken: tampered }, me),
          [401],
        );
        const unsigned = unsignedToken(alice.accessToken, { [claim]: payload });
        expectStatus(
          problems,
          `alg=none JWT ${claim}`,
          payload,
          await asUser({ accessToken: unsigned }, me),
          [401],
        );
      }
      // Defence in depth: a token signed with the real key but carrying SQL claims is refused by the claim schema.
      const { token: signedSid } = await testApp.container.accessTokens.sign({
        ...alice.claims,
        sessionId: payload,
      });
      expectStatus(problems, 'signed JWT sid', payload, await asUser({ accessToken: signedSid }, me), [401]);
      const { token: signedSub } = await testApp.container.accessTokens.sign({
        ...alice.claims,
        userId: payload,
      });
      expectStatus(problems, 'signed JWT sub', payload, await asUser({ accessToken: signedSub }, me), [401]);
    }
    expectNoProblems(problems);
    await assertIntact();
  });

  it('DELETE /auth/sessions/:sessionId: SQL in the path -> 400/404', async () => {
    const problems: string[] = [];
    for (const payload of PAYLOADS) {
      const probe = await asUser(alice, { method: 'DELETE', url: `/api/v1/auth/sessions/${enc(payload)}` });
      expectStatus(problems, 'DELETE /auth/sessions/:sessionId', payload, probe, [400, 404, 414]);
    }
    expectNoProblems(problems);
    await assertIntact();
  });

  it('headers: SQL in User-Agent is stored verbatim (sessions, audit); in X-Request-Id and X-Forwarded-For it is discarded', async () => {
    const username = freshUsername();
    expect(
      (await register({ username, password: PASSWORD, displayName: 'SQLi headers' })).response.statusCode,
    ).toBe(201);
    const problems: string[] = [];
    for (const payload of HEADER_PAYLOADS) {
      const where = 'login headers user-agent/x-request-id/x-forwarded-for';
      // From the trusted loopback hop, so X-Forwarded-For is honoured and its (invalid) value becomes request.ip.
      const probe = await login(username, PASSWORD, {
        remoteAddress: '127.0.0.1',
        headers: { 'user-agent': payload, 'x-request-id': payload, 'x-forwarded-for': payload },
      });
      expectStatus(problems, where, payload, probe, [200]);
      if (probe.response.statusCode !== 200) continue;
      const requestId = String(probe.response.headers['x-request-id']);
      if (requestId === payload) problems.push(`${where} ${show(payload)}: an invalid X-Request-Id was kept`);
      const auth = probe.response.json<AuthResponse>();
      const list = await asUser(auth, { method: 'GET', url: '/api/v1/auth/sessions' });
      const session = list.response
        .json<SessionListResponse>()
        .items.find((item) => item.id === auth.sessionId);
      const userAgent = normalizeUserAgent(payload);
      if (session?.userAgent !== userAgent || session.ip !== null) {
        problems.push(
          `${where} ${show(payload)}: session userAgent ${show(session?.userAgent ?? '<null>')} ip ${show(
            session?.ip ?? '<null>',
          )}, expected userAgent ${show(userAgent ?? '<null>')} and ip null`,
        );
      }
      const audited = await waitFor(
        async () =>
          (await testApp.container.db.query<{ user_agent: string | null }>(AUDIT_USER_AGENT, [requestId]))[0],
        { timeoutMs: 5000, description: `audit row of ${requestId}` },
      );
      if (audited.user_agent !== userAgent) {
        problems.push(`${where} ${show(payload)}: audit user_agent ${show(audited.user_agent ?? '<null>')}`);
      }
    }
    expectNoProblems(problems);
    await assertIntact();
  }, 120_000);
});

// -- REST: areas ----------------------------------------------------------------------------------------------

describe('REST areas inputs', () => {
  it('POST /areas: SQL in the name is stored and returned verbatim (sanitised), or 400', async () => {
    const problems: string[] = [];
    for (const payload of PAYLOADS) {
      const where = 'POST /areas body.name';
      const expected = expectedText(payload, LIMITS.nameRawMaxLength, NAME_RULES);
      const probe = await createArea({ name: payload, geometry: square() });
      if (!expected.accepted) {
        expectStatus(problems, where, payload, probe, [400]);
        continue;
      }
      expectStatus(problems, where, payload, probe, [201]);
      if (probe.response.statusCode !== 201) continue;
      const { area } = probe.response.json<AreaMutationResponse>();
      if (payloadAreaId === '') payloadAreaId = area.id;
      const fetched = (
        await asUser(alice, { method: 'GET', url: `/api/v1/areas/${area.id}` })
      ).response.json<AreaDto>();
      const stored = await areaText(area.id);
      if (
        area.name !== expected.value ||
        fetched.name !== expected.value ||
        stored?.name !== expected.value
      ) {
        problems.push(
          `${where} ${show(payload)}: returned ${show(area.name)}, read back ${show(fetched.name)}, stored ${show(
            stored?.name ?? '<none>',
          )}, expected ${show(expected.value ?? '')}`,
        );
      }
    }
    expectNoProblems(problems);
    await assertIntact();
  }, 60_000);

  it('POST /areas: SQL in the description is stored and returned verbatim (sanitised), or 400', async () => {
    const problems: string[] = [];
    for (const payload of PAYLOADS) {
      const where = 'POST /areas body.description';
      const expected = expectedText(payload, LIMITS.descriptionRawMaxLength, DESCRIPTION_RULES);
      const probe = await createArea({ name: 'SQLi description', description: payload, geometry: square() });
      if (!expected.accepted) {
        expectStatus(problems, where, payload, probe, [400]);
        continue;
      }
      expectStatus(problems, where, payload, probe, [201]);
      if (probe.response.statusCode !== 201) continue;
      const { area } = probe.response.json<AreaMutationResponse>();
      const stored = await areaText(area.id);
      if (area.description !== expected.value || stored?.description !== expected.value) {
        problems.push(
          `${where} ${show(payload)}: returned ${show(area.description ?? '<null>')}, stored ${show(
            stored?.description ?? '<null>',
          )}, expected ${show(expected.value ?? '<null>')}`,
        );
      }
    }
    expectNoProblems(problems);
    await assertIntact();
  }, 60_000);

  it('POST /areas: SQL in id, geometry.type, coordinates, GeoJSON members or the raw body -> 4xx', async () => {
    const problems: string[] = [];
    const post = (body: unknown): Promise<Probe> => createArea(body as Record<string, unknown>);
    for (const payload of PAYLOADS) {
      const geometry = square();
      expectStatus(problems, 'body.id', payload, await post({ id: payload, name: 'x', geometry }), [400]);
      expectStatus(
        problems,
        'body.geometry.type',
        payload,
        await post({ name: 'x', geometry: { ...geometry, type: payload } }),
        [400, 422],
      );
      expectStatus(
        problems,
        'body.geometry.coordinates',
        payload,
        await post({
          name: 'x',
          geometry: {
            type: 'Polygon',
            coordinates: [
              [
                [payload, payload],
                [1, 2],
                [2, 2],
                [payload, payload],
              ],
            ],
          },
        }),
        [400],
      );
      expectStatus(
        problems,
        'body.geometry (string)',
        payload,
        await post({ name: 'x', geometry: payload }),
        [400],
      );
      expectStatus(
        problems,
        'body.geometry.properties',
        payload,
        await post({ name: 'x', geometry: { ...geometry, properties: { name: payload } } }),
        [400],
      );
      expectStatus(
        problems,
        'body.geometry.crs',
        payload,
        await post({
          name: 'x',
          geometry: { ...geometry, crs: { type: 'name', properties: { name: payload } } },
        }),
        [400],
      );
      expectStatus(
        problems,
        'body.geometry (Feature)',
        payload,
        await post({ name: 'x', geometry: { type: 'Feature', geometry, properties: { name: payload } } }),
        [400],
      );
      const raw = await asUser(alice, {
        method: 'POST',
        url: '/api/v1/areas',
        headers: { 'content-type': 'application/json' },
        payload,
      });
      if (raw.response.statusCode === 201) created.areas += 1;
      expectStatus(problems, 'raw JSON body', payload, raw, [400]);
    }
    expectNoProblems(problems);
    await assertIntact();
  }, 60_000);

  it('PATCH /areas/:id: SQL in name/description is stored verbatim; in baseVersion/revertedFrom -> 400', async () => {
    const target = (
      await createArea({ name: 'SQLi patch target', geometry: square() })
    ).response.json<AreaMutationResponse>().area;
    let version = target.version;
    const problems: string[] = [];
    for (const field of ['name', 'description'] as const) {
      for (const payload of PAYLOADS) {
        const where = `PATCH /areas/:id body.${field}`;
        const expected =
          field === 'name'
            ? expectedText(payload, LIMITS.nameRawMaxLength, NAME_RULES)
            : expectedText(payload, LIMITS.descriptionRawMaxLength, DESCRIPTION_RULES);
        const probe = await writeArea({
          method: 'PATCH',
          url: `/api/v1/areas/${target.id}`,
          payload: { baseVersion: version, [field]: payload },
        });
        if (!expected.accepted) {
          expectStatus(problems, where, payload, probe, [400]);
          continue;
        }
        expectStatus(problems, where, payload, probe, [200]);
        if (probe.response.statusCode !== 200) continue;
        const { area } = probe.response.json<AreaMutationResponse>();
        version = area.version;
        const stored = await areaText(target.id);
        if (area[field] !== expected.value || stored?.[field] !== expected.value) {
          problems.push(
            `${where} ${show(payload)}: returned ${show(area[field] ?? '<null>')}, stored ${show(
              stored?.[field] ?? '<null>',
            )}, expected ${show(expected.value ?? '<null>')}`,
          );
        }
      }
    }
    for (const payload of PAYLOADS) {
      const url = `/api/v1/areas/${target.id}`;
      expectStatus(
        problems,
        'PATCH body.baseVersion',
        payload,
        await writeArea({ method: 'PATCH', url, payload: { baseVersion: payload, name: 'x' } }),
        [400],
      );
      expectStatus(
        problems,
        'PATCH body.revertedFrom',
        payload,
        await writeArea({
          method: 'PATCH',
          url,
          payload: { baseVersion: version, revertedFrom: payload, name: 'y' },
        }),
        [400],
      );
    }
    expectNoProblems(problems);
    await assertIntact();
  }, 60_000);

  it('DELETE / restore: SQL in baseVersion -> 400; a payload-named area soft-deletes and restores as data', async () => {
    const name = "'; DROP TABLE areas; --";
    const description = '$$ OR 1=1 $$';
    const doomed = (
      await createArea({ name, description, geometry: square() })
    ).response.json<AreaMutationResponse>().area;
    const problems: string[] = [];
    for (const payload of PAYLOADS) {
      expectStatus(
        problems,
        'DELETE /areas/:id ?baseVersion',
        payload,
        await writeArea({ method: 'DELETE', url: `/api/v1/areas/${doomed.id}?baseVersion=${enc(payload)}` }),
        [400],
      );
      expectStatus(
        problems,
        'POST /areas/:id/restore body.baseVersion',
        payload,
        await writeArea({
          method: 'POST',
          url: `/api/v1/areas/${doomed.id}/restore`,
          payload: { baseVersion: payload },
        }),
        [400],
      );
    }
    expectNoProblems(problems);

    const deleted = await writeArea({ method: 'DELETE', url: `/api/v1/areas/${doomed.id}?baseVersion=1` });
    expect(deleted.response.statusCode, deleted.response.body).toBe(200);
    const list = await asUser(alice, {
      method: 'GET',
      url: `/api/v1/areas?bbox=${LIST_BBOX}&zoom=15&limit=2000`,
    });
    expect(list.response.json<AreaListResponse>().items.map((item) => item.id)).not.toContain(doomed.id);
    const history = await asUser(alice, { method: 'GET', url: `/api/v1/areas/${doomed.id}/versions` });
    expect(
      history.response.json<AreaVersionListResponse>().items.map((item) => [item.op, item.name]),
    ).toEqual([
      ['delete', name],
      ['create', name],
    ]);
    const restored = await writeArea({
      method: 'POST',
      url: `/api/v1/areas/${doomed.id}/restore`,
      payload: { baseVersion: 2 },
    });
    expect(restored.response.statusCode, restored.response.body).toBe(200);
    expect(restored.response.json<AreaMutationResponse>().area).toMatchObject({
      name,
      description,
      deletedAt: null,
    });
    await assertIntact();
  });

  it('GET /areas: SQL in bbox, zoom, limit and cursor -> 400; forged cursors -> 400 INVALID_CURSOR', async () => {
    const control = await asUser(alice, {
      method: 'GET',
      url: `/api/v1/areas?bbox=${LIST_BBOX}&zoom=15&limit=2`,
    });
    expect(control.response.statusCode, control.response.body).toBe(200);
    const { queryBbox } = control.response.json<AreaListResponse>();
    const binding = queryBinding({ queryBbox, zoom: 15, limit: 2 });
    const list = (query: Record<string, string>): Promise<Probe> =>
      asUser(alice, { method: 'GET', url: `/api/v1/areas?${new URLSearchParams(query).toString()}` });
    const problems: string[] = [];
    for (const payload of PAYLOADS) {
      expectStatus(problems, '?bbox', payload, await list({ bbox: payload, zoom: '15' }), [400]);
      expectStatus(
        problems,
        '?bbox (4th value)',
        payload,
        await list({ bbox: `35.19,31.69,35.4,${payload}`, zoom: '15' }),
        [400],
      );
      expectStatus(problems, '?zoom', payload, await list({ bbox: LIST_BBOX, zoom: payload }), [400]);
      expectStatus(
        problems,
        '?limit',
        payload,
        await list({ bbox: LIST_BBOX, zoom: '15', limit: payload }),
        [400],
      );
      expectStatus(
        problems,
        '?cursor',
        payload,
        await list({ bbox: LIST_BBOX, zoom: '15', limit: '2', cursor: payload }),
        [400],
      );
      const forged = [
        b64url({ v: 1, id: payload, z: 15, b: binding }),
        b64url({ v: 1, id: randomUUID(), z: payload, b: binding }),
        b64url({ v: 1, id: randomUUID(), z: 15, b: payload }),
        b64url(payload),
      ];
      for (const cursor of forged) {
        expectStatus(
          problems,
          '?cursor (forged)',
          payload,
          await list({ bbox: LIST_BBOX, zoom: '15', limit: '2', cursor }),
          [400],
        );
      }
    }
    expectNoProblems(problems);
    // A cursor forged with the (public) binding and a real UUID is just a keyset position.
    const keyset = b64url({ v: 1, id: '00000000-0000-4000-8000-000000000000', z: 15, b: binding });
    expect(
      (await list({ bbox: LIST_BBOX, zoom: '15', limit: '2', cursor: keyset })).response.statusCode,
    ).toBe(200);
    await assertIntact();
  }, 60_000);

  it('GET /areas/:id, /versions, /versions/:version and /changes: SQL in params and query -> 4xx', async () => {
    const id = payloadAreaId;
    const get = (url: string): Promise<Probe> => asUser(alice, { method: 'GET', url });
    const problems: string[] = [];
    for (const payload of PAYLOADS) {
      const p = enc(payload);
      expectStatus(problems, 'GET /areas/:id', payload, await get(`/api/v1/areas/${p}`), [400, 404, 414]);
      expectStatus(
        problems,
        'GET /areas/:id ?includeDeleted',
        payload,
        await get(`/api/v1/areas/${id}?includeDeleted=${p}`),
        [400],
      );
      expectStatus(
        problems,
        'GET /areas/:id/versions',
        payload,
        await get(`/api/v1/areas/${p}/versions`),
        [400, 404, 414],
      );
      expectStatus(
        problems,
        'GET /versions ?cursor',
        payload,
        await get(`/api/v1/areas/${id}/versions?cursor=${p}`),
        [400],
      );
      expectStatus(
        problems,
        'GET /versions ?limit',
        payload,
        await get(`/api/v1/areas/${id}/versions?limit=${p}`),
        [400],
      );
      expectStatus(
        problems,
        'GET /versions ?includeGeometry',
        payload,
        await get(`/api/v1/areas/${id}/versions?includeGeometry=${p}`),
        [400],
      );
      expectStatus(
        problems,
        'GET /versions/:version',
        payload,
        await get(`/api/v1/areas/${id}/versions/${p}`),
        [400, 404, 414],
      );
      expectStatus(
        problems,
        'GET /areas/changes ?since',
        payload,
        await get(`/api/v1/areas/changes?since=${p}`),
        [400],
      );
      expectStatus(
        problems,
        'GET /areas/changes ?limit',
        payload,
        await get(`/api/v1/areas/changes?since=0&limit=${p}`),
        [400],
      );
    }
    expectNoProblems(problems);
    expect((await get(`/api/v1/areas/${id}/versions?includeGeometry=true`)).response.statusCode).toBe(200);
    expect((await get('/api/v1/areas/changes?since=0')).response.statusCode).toBe(200);
    await assertIntact();
  }, 60_000);
});

// -- REST: admin ----------------------------------------------------------------------------------------------

describe('REST admin inputs', () => {
  const NO_FILTERS = { actorId: null, action: null, outcome: null, from: null, to: null };

  function auditLogs(query: Record<string, string>): Promise<Probe> {
    return asUser(admin, {
      method: 'GET',
      url: `/api/v1/admin/audit-logs?${new URLSearchParams(query).toString()}`,
    });
  }

  it('GET /admin/audit-logs: SQL in every filter and the cursor -> 400; forged cursors -> 400', async () => {
    const fingerprint = filtersFingerprint(NO_FILTERS);
    const problems: string[] = [];
    for (const payload of PAYLOADS) {
      for (const param of ['actorId', 'action', 'outcome', 'from', 'to', 'limit', 'cursor']) {
        expectStatus(
          problems,
          `GET /admin/audit-logs ?${param}`,
          payload,
          await auditLogs({ [param]: payload }),
          [400],
        );
      }
      expectStatus(
        problems,
        'GET /admin/audit-logs ?cursor (forged id)',
        payload,
        await auditLogs({ cursor: b64url(`${payload}.${fingerprint}`) }),
        [400],
      );
    }
    expectStatus(
      problems,
      '?cursor (forged)',
      '1 OR 1=1',
      await auditLogs({ cursor: b64url(`1 OR 1=1.${fingerprint}`) }),
      [400],
    );
    expectNoProblems(problems);
    // The (public) fingerprint plus any id is just a keyset position.
    const keyset = await auditLogs({ cursor: b64url(`9007199254740991.${fingerprint}`) });
    expect(keyset.response.statusCode, keyset.response.body).toBe(200);
    await assertIntact();
  }, 60_000);

  it('GET /admin/audit-logs: "_" in the action filter is a literal, never a LIKE wildcard', async () => {
    const creates = await waitFor(
      async () => {
        const probe = await auditLogs({ action: 'area.create' });
        return probe.response.json<AuditLogListResponse>().items.length > 0 && probe;
      },
      { timeoutMs: 5000, description: 'area.create audit rows' },
    );
    expect(creates.response.statusCode).toBe(200);
    for (const action of ['area.creat_', 'area.______', '____.create']) {
      const probe = await auditLogs({ action });
      expect(probe.response.statusCode, probe.response.body).toBe(200);
      expect(probe.response.json<AuditLogListResponse>().items, action).toEqual([]);
    }
  });

  it('GET /admin/audit-stats: SQL in from/to -> 400', async () => {
    const problems: string[] = [];
    for (const payload of PAYLOADS) {
      for (const param of ['from', 'to']) {
        const probe = await asUser(admin, {
          method: 'GET',
          url: `/api/v1/admin/audit-stats?${new URLSearchParams({ [param]: payload }).toString()}`,
        });
        expectStatus(problems, `GET /admin/audit-stats ?${param}`, payload, probe, [400]);
      }
    }
    expectNoProblems(problems);
    await assertIntact();
  });
});

// -- WebSocket ------------------------------------------------------------------------------------------------

describe('WebSocket inputs', () => {
  /** Below the gateway's 20 invalid messages per 60 s (close 4400): a fresh socket after this many. */
  const INVALID_PER_SOCKET = 15;
  const VIEWPORT = [35.19, 31.69, 35.4, 31.72];
  const DRAFT = randomUUID();
  const AREA = randomUUID();

  /** One variant per string-typed (or string-injectable) field of every client message type. */
  const VARIANTS: readonly {
    where: string;
    message: (payload: string) => { type: unknown; data: unknown };
  }[] = [
    { where: 'type', message: (p) => ({ type: p, data: {} }) },
    {
      where: 'viewport.set data.bbox[0]',
      message: (p) => ({ type: 'viewport.set', data: { bbox: [p, 31.69, 35.4, 31.72], zoom: 15 } }),
    },
    {
      where: 'viewport.set data.zoom',
      message: (p) => ({ type: 'viewport.set', data: { bbox: VIEWPORT, zoom: p } }),
    },
    {
      where: 'presence.update data.status',
      message: (p) => ({ type: 'presence.update', data: { status: p } }),
    },
    {
      where: 'draft.start data.draftId',
      message: (p) => ({ type: 'draft.start', data: { draftId: p, areaId: null, resume: false } }),
    },
    {
      where: 'draft.start data.areaId',
      message: (p) => ({ type: 'draft.start', data: { draftId: DRAFT, areaId: p, resume: false } }),
    },
    {
      where: 'draft.start data.resume',
      message: (p) => ({ type: 'draft.start', data: { draftId: DRAFT, areaId: null, resume: p } }),
    },
    {
      where: 'draft.update data.draftId',
      message: (p) => ({ type: 'draft.update', data: { draftId: p, rev: 1, vertices: [], cursor: null } }),
    },
    {
      where: 'draft.update data.rev',
      message: (p) => ({
        type: 'draft.update',
        data: { draftId: DRAFT, rev: p, vertices: [], cursor: null },
      }),
    },
    {
      where: 'draft.update data.vertices',
      message: (p) => ({
        type: 'draft.update',
        data: { draftId: DRAFT, rev: 1, vertices: [[p, p]], cursor: null },
      }),
    },
    {
      where: 'draft.update data.cursor',
      message: (p) => ({ type: 'draft.update', data: { draftId: DRAFT, rev: 1, vertices: [], cursor: p } }),
    },
    { where: 'draft.touch data.draftId', message: (p) => ({ type: 'draft.touch', data: { draftId: p } }) },
    {
      where: 'draft.end data.draftId',
      message: (p) => ({ type: 'draft.end', data: { draftId: p, outcome: 'cancelled', areaId: null } }),
    },
    {
      where: 'draft.end data.outcome',
      message: (p) => ({ type: 'draft.end', data: { draftId: DRAFT, outcome: p, areaId: null } }),
    },
    {
      where: 'draft.end data.areaId',
      message: (p) => ({ type: 'draft.end', data: { draftId: DRAFT, outcome: 'committed', areaId: p } }),
    },
    {
      where: 'lock.acquire data.areaId',
      message: (p) => ({ type: 'lock.acquire', data: { areaId: p, scope: 'geometry' } }),
    },
    {
      where: 'lock.acquire data.scope',
      message: (p) => ({ type: 'lock.acquire', data: { areaId: AREA, scope: p } }),
    },
    { where: 'lock.release data.areaId', message: (p) => ({ type: 'lock.release', data: { areaId: p } }) },
    { where: 'ping data.t', message: (p) => ({ type: 'ping', data: { t: p } }) },
    { where: 'ping data.<unknown key>', message: (p) => ({ type: 'ping', data: { t: 1, [p]: p } }) },
  ];

  async function openSocket(): Promise<WsClient> {
    const ticket = await issueTicket(testApp.container, alice, alice.sessionId);
    const client = await openClient(testApp, ticket);
    await client.waitFor((message) => message.type === 'lock.snapshot');
    return client;
  }

  /** Closes a socket that must still be open (a server-side close would mean a handler failed) and opens a new one. */
  async function replaceSocket(client: WsClient, problems: string[]): Promise<WsClient> {
    if (client.closeCode !== null)
      problems.push(`WS socket was closed by the server with ${client.closeCode}`);
    await client.close();
    return openSocket();
  }

  const unreferencedErrors = (client: WsClient): ServerMessage[] =>
    client.ofType('error').filter((message) => message.ref === undefined);

  function describeReply(reply: ServerMessage | undefined, ms: number): string {
    return `${reply === undefined ? 'no reply' : JSON.stringify(reply).slice(0, 240)} in ${Math.round(ms)} ms`;
  }

  it('upgrade: SQL in the ticket -> 401; ticket claims with SQL read back from Redis -> 401', async () => {
    const problems: string[] = [];
    for (const payload of PAYLOADS) {
      let started = performance.now();
      let status = await handshakeStatus(testApp, payload);
      let ms = performance.now() - started;
      if (![400, 401].includes(status) || ms >= MAX_REPLY_MS) {
        problems.push(`WS upgrade ?ticket ${show(payload)} → ${status} in ${Math.round(ms)} ms`);
      }
      // As if Redis held attacker-shaped claims: they are schema-checked before the session lookup.
      const { ticket } = await testApp.container.wsTickets.issue({
        userId: alice.id,
        sessionId: payload,
        displayName: alice.displayName,
        color: alice.color,
        role: 'user',
        absoluteExpiresAt: new Date(Date.now() + 3_600_000).toISOString(),
      });
      started = performance.now();
      status = await handshakeStatus(testApp, ticket);
      ms = performance.now() - started;
      if (status !== 401 || ms >= MAX_REPLY_MS) {
        problems.push(
          `WS upgrade, Redis claims sessionId ${show(payload)} → ${status} in ${Math.round(ms)} ms`,
        );
      }
    }
    expectNoProblems(problems);
    await assertIntact();
  }, 60_000);

  it('every field of every client message, the ref and raw frames: SQL -> VALIDATION_FAILED / UNKNOWN_MESSAGE_TYPE / MALFORMED_JSON, never INTERNAL_ERROR', async () => {
    const problems: string[] = [];
    let client = await openSocket();
    let invalidOnSocket = 0;
    let refCounter = 0;
    const rotate = async (): Promise<void> => {
      if (invalidOnSocket < INVALID_PER_SOCKET) return;
      client = await replaceSocket(client, problems);
      invalidOnSocket = 0;
    };

    for (const variant of VARIANTS) {
      for (const payload of PAYLOADS) {
        await rotate();
        refCounter += 1;
        const ref = `sqli${refCounter}`;
        const started = performance.now();
        client.send({ ...variant.message(payload), ref });
        const reply = await client.waitFor((message) => message.ref === ref, 3000).catch(() => undefined);
        const ms = performance.now() - started;
        invalidOnSocket += 1;
        const code = reply?.type === 'error' ? reply.data['code'] : undefined;
        if ((code !== 'VALIDATION_FAILED' && code !== 'UNKNOWN_MESSAGE_TYPE') || ms >= MAX_REPLY_MS) {
          problems.push(`WS ${variant.where} ${show(payload)} → ${describeReply(reply, ms)}`);
        }
      }
    }

    // SQL as the correlation ref, and as the whole (non-JSON or unexpected-JSON) frame: errors carry no ref.
    const frames: { where: string; frame: (payload: string) => unknown; codes: readonly unknown[] }[] = [
      {
        where: 'ref',
        frame: (p) => ({ type: 'ping', ref: p, data: { t: 1 } }),
        codes: ['VALIDATION_FAILED'],
      },
      {
        where: 'raw frame',
        frame: (p) => p,
        codes: ['MALFORMED_JSON', 'VALIDATION_FAILED', 'UNKNOWN_MESSAGE_TYPE'],
      },
    ];
    for (const { where, frame, codes } of frames) {
      for (const payload of PAYLOADS) {
        await rotate();
        const before = unreferencedErrors(client).length;
        const started = performance.now();
        client.send(frame(payload));
        const reply = await waitFor(() => unreferencedErrors(client)[before], { timeoutMs: 3000 }).catch(
          () => undefined,
        );
        const ms = performance.now() - started;
        invalidOnSocket += 1;
        if (!codes.includes(reply?.data['code']) || ms >= MAX_REPLY_MS) {
          problems.push(`WS ${where} ${show(payload)} → ${describeReply(reply, ms)}`);
        }
      }
    }

    // The socket survived all of it and still answers.
    const pong = await client.request('ping', { t: 42 });
    expect(pong.type).toBe('pong');
    await client.close();
    expectNoProblems(problems);
    await assertIntact();
  }, 180_000);

  it('lock.acquire reaches SQL only with a UUID: unknown -> AREA_NOT_FOUND; a payload-named area locks as data', async () => {
    const client = await openSocket();
    const unknown = await client.request('lock.acquire', { areaId: randomUUID(), scope: 'geometry' });
    expect(unknown).toMatchObject({ type: 'error', data: { code: 'AREA_NOT_FOUND' } });
    const acquired = await client.request('lock.acquire', { areaId: payloadAreaId, scope: 'details' });
    expect(acquired).toMatchObject({ type: 'lock.acquired', data: { areaId: payloadAreaId } });
    expect((await client.request('lock.release', { areaId: payloadAreaId })).type).toBe('ack');
    await client.close();
    await assertIntact();
  });
});

// -- Operator CLIs --------------------------------------------------------------------------------------------

describe('CLI arguments', () => {
  function cliContext(): UserAdminContext {
    return {
      db: testApp.container.db,
      revocations: testApp.container.revocations,
      events: testApp.container.events,
      audit: testApp.container.audit,
      accessTokenTtlS: testApp.config.ACCESS_TOKEN_TTL_S,
      close: () => Promise.resolve(),
    };
  }

  async function userAdmin(argv: string[]): Promise<{ code: number; opened: boolean; stderr: string }> {
    let stderr = '';
    const openContext = vi.fn(() => Promise.resolve(cliContext()));
    const code = await runUserAdmin(argv, {
      stdout: { write: () => true },
      stderr: { write: (chunk: string) => (stderr += chunk) },
      logger: pino({ level: 'silent' }),
      openContext,
      operator: () => 'sqli-battery',
    });
    return { code, opened: openContext.mock.calls.length > 0, stderr };
  }

  it('user-admin: SQL in --username or the command is refused before any connection is opened', async () => {
    const problems: string[] = [];
    for (const payload of PAYLOADS) {
      for (const argv of [
        ['grant-admin', '--username', payload],
        ['disable', '--username', payload],
        [payload, '--username', alice.username],
      ]) {
        const result = await userAdmin(argv);
        if (result.code !== 1 || result.opened) {
          problems.push(
            `user-admin ${JSON.stringify(argv).slice(0, 120)} → exit ${result.code}, opened ${result.opened}`,
          );
        }
      }
    }
    expectNoProblems(problems);
    await assertIntact();
  });

  it('user-admin: LIKE look-alikes of a real username reach SQL and match nobody', async () => {
    const lookalikes = [`_${alice.username.slice(1)}`, `${alice.username.slice(0, -1)}_`];
    for (const lookalike of lookalikes) {
      for (const op of ['grant-admin', 'disable']) {
        const result = await userAdmin([op, '--username', lookalike]);
        expect(result, `${op} ${lookalike}`).toMatchObject({ code: 1, opened: true });
      }
    }
    const [row] = await testApp.container.db.query<{ role: string; disabled_at: Date | null }>(USER_ROW, [
      alice.id,
    ]);
    expect(row).toMatchObject({ role: 'user', disabled_at: null });
    await assertIntact();
  });

  it('seed: SQL in any numeric flag is refused at argument validation', async () => {
    const problems: string[] = [];
    for (const payload of PAYLOADS) {
      for (const flag of ['--count', '--region-count', '--seed', '--users']) {
        let stderr = '';
        const code = await runSeed([flag, payload], {
          stdout: { write: () => true },
          stderr: { write: (chunk: string) => (stderr += chunk) },
          logger: pino({ level: 'silent' }),
        });
        if (code !== 1 || !stderr.startsWith('error:')) {
          problems.push(`seed ${flag} ${show(payload)} → exit ${code}: ${stderr.slice(0, 120)}`);
        }
      }
    }
    expectNoProblems(problems);
    await assertIntact();
  });
});

// -- Audit trail of refused requests --------------------------------------------------------------------------

describe('audit trail of refused injection attempts', () => {
  async function rejectedAuditRows(): Promise<number> {
    const metric = await testApp.container.metrics.auditEventsTotal.get();
    return metric.values.find((value) => value.labels.result === 'rejected')?.value ?? 0;
  }

  /** The refused request's generic failure row (audit hook) once the buffered writer flushed; undefined if lost. */
  function auditRow(probe: Probe): Promise<{ target_id: string | null } | undefined> {
    const requestId = String(probe.response.headers['x-request-id']);
    return waitFor(
      async () =>
        (await testApp.container.db.query<{ target_id: string | null }>(AUDIT_TARGET_ID, [requestId]))[0],
      { timeoutMs: 3000 },
    ).catch(() => undefined);
  }

  /** Audited routes whose path parameter is refused by transport validation (400, free of drawing charges). */
  const refusals = (param: string): (InjectOptions & { url: string })[] => [
    { method: 'DELETE', url: `/api/v1/auth/sessions/${enc(param)}` },
    { method: 'PATCH', url: `/api/v1/areas/${enc(param)}`, payload: { baseVersion: 1, name: 'x' } },
    { method: 'DELETE', url: `/api/v1/areas/${enc(param)}?baseVersion=1` },
    { method: 'POST', url: `/api/v1/areas/${enc(param)}/restore`, payload: { baseVersion: 1 } },
  ];

  it.each([
    ['without a NUL byte', "'; DROP TABLE users; --"],
    ['with a NUL byte', `a${NUL}'; DROP TABLE users; --`],
  ])(
    'a path parameter %s: each refused request keeps its audit row (no target: not a UUID) and PostgreSQL rejects none',
    async (_label, param) => {
      const rejectedBefore = await rejectedAuditRows();
      const lost: string[] = [];
      const rawTargets: string[] = [];
      for (const options of refusals(param)) {
        const probe = await asUser(alice, options);
        expect(probe.response.statusCode, probe.response.body).toBe(400);
        const where = `${options.method} ${options.url} (x-request-id ${String(probe.response.headers['x-request-id'])})`;
        const row = await auditRow(probe);
        if (row === undefined) lost.push(where);
        else if (row.target_id !== null) rawTargets.push(`${where}: target_id ${show(row.target_id)}`);
      }
      expect({ lost, rawTargets, rejected: (await rejectedAuditRows()) - rejectedBefore }).toEqual({
        lost: [],
        rawTargets: [],
        rejected: 0,
      });
    },
  );
});

// -- Afterwards -----------------------------------------------------------------------------------------------

describe('after the battery', () => {
  it('tables intact with exact row counts, no admin escalation, no running pg_sleep', async () => {
    await assertIntact();
    const [sleeps] = await testApp.container.db.query<{ n: number }>(ACTIVE_SLEEPS);
    expect(sleeps?.n).toBe(0);
    const [aliceRow] = await testApp.container.db.query<{ role: string }>(USER_ROW, [alice.id]);
    expect(aliceRow?.role).toBe('user');
  });
});
