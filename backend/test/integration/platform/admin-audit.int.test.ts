/**
 * Admin audit endpoints (SPEC section 6.4, section 10.4): admin-only (the CURRENT role, via requireRole), every call audited as
 * `admin.audit_query` exactly once - successes with the endpoint and filters, refusals as `denied` and failures with
 * the generic `{ code, status }` - and `GET /admin/audit-logs` filters with a keyset cursor bound to the filters.
 */
import { randomUUID } from 'node:crypto';

import { AuditLogListResponseSchema, AuditStatsResponseSchema, ProblemSchema } from '@snapland/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { InMemoryAuditLogger } from '../../../src/infra/audit/in-memory.js';
import { createAdminModule } from '../../../src/modules/admin/index.js';
import { createMemoryAudit } from '../../helpers/audit.js';
import { createTestApp } from '../../helpers/test-app.js';
import type { TestApp } from '../../helpers/test-app.js';
import { bearer, createUser } from '../../helpers/users.js';
import type { TestUser } from '../../helpers/users.js';
import { deleteAuditRows, insertAuditRows } from './support/audit-fixtures.js';

const FIXTURE_INSTANCE = `admin-it-${randomUUID().slice(0, 8)}`;

let testApp: TestApp;
let audit: InMemoryAuditLogger;
let admin: TestUser;
let user: TestUser;
/** Actor of the seeded rows (unique to this file). */
const actorX = randomUUID();
const actorY = randomUUID();
const base = new Date(Date.UTC(2026, 6, 1, 12, 0, 0));
let xIds: number[];

beforeAll(async () => {
  audit = createMemoryAudit();
  testApp = await createTestApp({ modules: [createAdminModule], overrides: { audit } });
  admin = await createUser(testApp.container, { role: 'admin' });
  user = await createUser(testApp.container);
  const at = (minutes: number): Date => new Date(base.getTime() + minutes * 60_000);
  xIds = await insertAuditRows(testApp.container, FIXTURE_INSTANCE, [
    {
      at: at(1),
      action: 'area.create',
      outcome: 'success',
      actorId: actorX,
      targetType: 'area',
      targetId: 'x1',
    },
    {
      at: at(2),
      action: 'area.create',
      outcome: 'success',
      actorId: actorX,
      targetType: 'area',
      targetId: 'x2',
    },
    {
      at: at(3),
      action: 'area.create',
      outcome: 'success',
      actorId: actorX,
      targetType: 'area',
      targetId: 'x3',
    },
    {
      at: at(4),
      action: 'area.delete',
      outcome: 'denied',
      actorId: actorX,
      targetType: 'area',
      targetId: 'x4',
    },
    {
      at: at(5),
      action: 'area.delete',
      outcome: 'denied',
      actorId: actorX,
      targetType: 'area',
      targetId: 'x5',
      details: { code: 'FORBIDDEN', status: 403 },
    },
  ]);
  await insertAuditRows(testApp.container, FIXTURE_INSTANCE, [
    {
      at: at(2),
      action: 'area.create',
      outcome: 'success',
      actorId: actorY,
      targetType: 'area',
      targetId: 'y1',
    },
  ]);
});

afterAll(async () => {
  await deleteAuditRows(testApp.container, FIXTURE_INSTANCE);
  await testApp.close();
});

function get(url: string, token: TestUser | null, requestId = `req-${randomUUID()}`) {
  return testApp.app.inject({
    method: 'GET',
    url,
    headers: { ...(token === null ? {} : bearer(token)), 'x-request-id': requestId },
  });
}

function queryEvents(requestId: string) {
  return audit.find((event) => event.action === 'admin.audit_query' && event.requestId === requestId);
}

describe('admin audit endpoints: access (section 6.4, section 10.7.5)', () => {
  it.each(['/api/v1/admin/audit-logs', '/api/v1/admin/audit-stats'])(
    '%s -> 403 FORBIDDEN for a non-admin, audited ONCE as denied',
    async (url) => {
      const requestId = `req-${randomUUID()}`;
      const response = await get(url, user, requestId);
      expect(response.statusCode).toBe(403);
      expect(ProblemSchema.parse(response.json())).toMatchObject({ code: 'FORBIDDEN' });
      const events = queryEvents(requestId);
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        outcome: 'denied',
        actorId: user.id,
        sessionId: user.sessionId,
        targetType: 'system',
      });
      expect(events[0]?.details).toEqual({ code: 'FORBIDDEN', status: 403 });
    },
  );

  it.each([
    '/api/v1/admin/audit-logs?limit=0',
    '/api/v1/admin/audit-logs?unknownParam=1',
    '/api/v1/admin/audit-stats?from=not-a-date',
  ])('%s -> 403 (not 400) for a non-admin: the role is checked before the query', async (url) => {
    const requestId = `req-${randomUUID()}`;
    const response = await get(url, user, requestId);
    expect(response.statusCode).toBe(403);
    const problem = ProblemSchema.parse(response.json());
    expect(problem).toMatchObject({ code: 'FORBIDDEN' });
    expect(JSON.stringify(problem)).not.toContain('querystring');
    const events = queryEvents(requestId);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ outcome: 'denied', actorId: user.id });
    expect(events[0]?.details).toEqual({ code: 'FORBIDDEN', status: 403 });
  });

  it('does not audit an unauthenticated request (its 401 is not a user action)', async () => {
    const requestId = `req-${randomUUID()}`;
    const response = await get('/api/v1/admin/audit-logs', null, requestId);
    expect(response.statusCode).toBe(401);
    expect(audit.find((event) => event.requestId === requestId)).toHaveLength(0);
  });
});

describe('GET /api/v1/admin/audit-logs', () => {
  it('filters by actor, action, outcome and time, newest first, and audits the query', async () => {
    const requestId = `req-${randomUUID()}`;
    const response = await get(
      `/api/v1/admin/audit-logs?actorId=${actorX}&action=area.create&outcome=success`,
      admin,
      requestId,
    );
    expect(response.statusCode).toBe(200);
    const body = AuditLogListResponseSchema.parse(response.json());
    expect(body.items.map((item) => item.targetId)).toEqual(['x3', 'x2', 'x1']);
    expect(body.nextCursor).toBeNull();
    expect(body.items[0]).toEqual({
      id: xIds[2],
      occurredAt: '2026-07-01T12:03:00.000Z',
      action: 'area.create',
      outcome: 'success',
      actorId: actorX,
      sessionId: null,
      targetType: 'area',
      targetId: 'x3',
      requestId: null,
      instanceId: FIXTURE_INSTANCE,
      ip: null,
      userAgent: null,
      details: {},
    });
    expect(queryEvents(requestId)).toEqual([
      expect.objectContaining({
        outcome: 'success',
        actorId: admin.id,
        details: {
          endpoint: 'audit-logs',
          filters: { actorId: actorX, action: 'area.create', outcome: 'success' },
        },
      }),
    ]);

    const window = await get(
      `/api/v1/admin/audit-logs?actorId=${actorX}&from=2026-07-01T12:02:00.000Z&to=2026-07-01T12:04:00.000Z`,
      admin,
    );
    expect(AuditLogListResponseSchema.parse(window.json()).items.map((item) => item.targetId)).toEqual([
      'x3',
      'x2',
    ]);
    const denied = await get(`/api/v1/admin/audit-logs?actorId=${actorX}&outcome=denied`, admin);
    expect(AuditLogListResponseSchema.parse(denied.json()).items.map((item) => item.details)).toEqual([
      { code: 'FORBIDDEN', status: 403 },
      {},
    ]);
  });

  it('pages with a keyset cursor (id DESC) that is refused for other filters', async () => {
    const seen: number[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const query: string = cursor === null ? '' : `&cursor=${cursor}`;
      const response = await get(`/api/v1/admin/audit-logs?actorId=${actorX}&limit=2${query}`, admin);
      expect(response.statusCode).toBe(200);
      const page = AuditLogListResponseSchema.parse(response.json());
      seen.push(...page.items.map((item) => item.id));
      cursor = page.nextCursor;
      pages += 1;
    } while (cursor !== null && pages < 10);
    expect(pages).toBe(3);
    expect(seen).toEqual([...xIds].reverse());

    const first = AuditLogListResponseSchema.parse(
      (await get(`/api/v1/admin/audit-logs?actorId=${actorX}&limit=2`, admin)).json(),
    );
    const requestId = `req-${randomUUID()}`;
    const replayed = await get(
      `/api/v1/admin/audit-logs?actorId=${actorY}&limit=2&cursor=${first.nextCursor ?? ''}`,
      admin,
      requestId,
    );
    expect(replayed.statusCode).toBe(400);
    expect(ProblemSchema.parse(replayed.json())).toMatchObject({ code: 'INVALID_CURSOR' });
    expect(queryEvents(requestId)).toEqual([
      expect.objectContaining({
        outcome: 'failure',
        actorId: admin.id,
        targetType: 'system',
        details: { code: 'INVALID_CURSOR', status: 400 },
      }),
    ]);
  });

  it('rejects an invalid query with 400, audited once as a failure', async () => {
    const requestId = `req-${randomUUID()}`;
    const response = await get('/api/v1/admin/audit-logs?limit=0', admin, requestId);
    expect(response.statusCode).toBe(400);
    expect(ProblemSchema.parse(response.json())).toMatchObject({ code: 'VALIDATION_FAILED' });
    expect(queryEvents(requestId)).toEqual([
      expect.objectContaining({
        outcome: 'failure',
        details: { code: 'VALIDATION_FAILED', status: 400 },
      }),
    ]);
  });
});

describe('GET /api/v1/admin/audit-stats (access and window)', () => {
  it('serves the default 24 h window to admins and audits the query', async () => {
    const requestId = `req-${randomUUID()}`;
    const response = await get('/api/v1/admin/audit-stats', admin, requestId);
    expect(response.statusCode).toBe(200);
    const stats = AuditStatsResponseSchema.parse(response.json());
    expect(Date.parse(stats.to) - Date.parse(stats.from)).toBe(24 * 60 * 60 * 1000);
    expect(queryEvents(requestId)).toEqual([
      expect.objectContaining({
        outcome: 'success',
        details: { endpoint: 'audit-stats', filters: { from: stats.from, to: stats.to } },
      }),
    ]);
  });

  it('refuses a window longer than 31 days (400, audited as a failure)', async () => {
    const requestId = `req-${randomUUID()}`;
    const response = await get(
      '/api/v1/admin/audit-stats?from=2026-01-01T00:00:00.000Z&to=2026-03-01T00:00:00.000Z',
      admin,
      requestId,
    );
    expect(response.statusCode).toBe(400);
    expect(ProblemSchema.parse(response.json())).toMatchObject({ code: 'VALIDATION_FAILED' });
    expect(queryEvents(requestId)).toEqual([
      expect.objectContaining({
        outcome: 'failure',
        details: { code: 'VALIDATION_FAILED', status: 400 },
      }),
    ]);
  });
});
