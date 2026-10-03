import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';

import type { InMemoryAuditLogger } from '../../../src/infra/audit/in-memory.js';
import { ConflictError, DependencyUnavailableError, ForbiddenError } from '../../../src/infra/http/errors.js';
import { rateLimitRoute } from '../../../src/infra/http/rate-limits.js';
import { createMemoryAudit } from '../../helpers/audit.js';
import { uniqueIp } from '../../helpers/net.js';
import { createTestApp } from '../../helpers/test-app.js';
import type { TestApp } from '../../helpers/test-app.js';
import { bearer, createUser } from '../../helpers/users.js';
import type { TestUser } from '../../helpers/users.js';
import { waitFor } from '../../helpers/wait-for.js';

const AREA_ID = '7d7a4c52-9a0b-4e0f-b3c1-2e5f6a7b8c9d';
function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve: () => void = () => undefined;
  const promise = new Promise<void>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

/** Holds `/areas/gated-success` open so a second request can overlap it. */
let gate = deferred();
let testApp: TestApp;
let audit: InMemoryAuditLogger;
let user: TestUser;

beforeAll(async () => {
  audit = createMemoryAudit();
  testApp = await createTestApp({
    config: { AUTH_RATE_LIMIT_MAX: 1 },
    overrides: { audit },
    routes: (scope, container) => {
      const audited = { onRequest: [scope.authenticate], config: { auditAction: 'area.create' as const } };
      scope.post(
        '/areas',
        { ...audited, bodyLimit: 512, schema: { body: z.strictObject({ name: z.string() }) } },
        () => ({ ok: true }),
      );
      scope.post('/areas/unavailable', audited, () => {
        throw new DependencyUnavailableError();
      });
      scope.post('/areas/gated-success', audited, async (request) => {
        const actor = request.actor();
        container.audit.record({ action: 'area.create', outcome: 'success', requestId: actor.requestId });
        await gate.promise;
        return { ok: true };
      });
      scope.post('/areas/recorded', audited, (request) => {
        const actor = request.actor();
        container.audit.record({
          action: 'area.create',
          outcome: 'failure',
          actorId: actor.userId,
          requestId: actor.requestId,
          details: { code: 'AREA_ID_CONFLICT' },
        });
        throw new ConflictError('AREA_ID_CONFLICT', 'Id in use.');
      });
      scope.delete(
        '/areas/:id',
        { onRequest: [scope.authenticate], config: { auditAction: 'area.delete' } },
        () => {
          throw new ForbiddenError();
        },
      );
      scope.post(
        '/login',
        { config: { auditAction: 'auth.login', rateLimit: rateLimitRoute('auth') } },
        () => ({ ok: true }),
      );
    },
  });
  user = await createUser(testApp.container);
});

afterAll(async () => {
  await testApp.close();
});

beforeEach(() => {
  audit.clear();
});

async function rowsFor(requestId: string, expected: number) {
  await testApp.container.auditCoalescer.flush();
  if (expected > 0)
    await waitFor(() => audit.find((event) => event.requestId === requestId).length >= expected);
  return audit.find((event) => event.requestId === requestId);
}

describe('generic onResponse audit hook (section 10.4)', () => {
  it('writes exactly one failure row for a 413 on an audited route', async () => {
    const response = await testApp.app.inject({
      method: 'POST',
      url: '/__test/areas',
      headers: bearer(user),
      payload: { name: 'x'.repeat(2000) },
    });
    expect(response.statusCode).toBe(413);
    const rows = await rowsFor(String(response.headers['x-request-id']), 1);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      action: 'area.create',
      outcome: 'failure',
      actorId: user.id,
      details: { code: 'PAYLOAD_TOO_LARGE', status: 413 },
    });
  });

  it('writes exactly one failure row for a 415', async () => {
    const response = await testApp.app.inject({
      method: 'POST',
      url: '/__test/areas',
      headers: { ...bearer(user), 'content-type': 'text/plain' },
      payload: 'name',
    });
    expect(response.statusCode).toBe(415);
    const rows = await rowsFor(String(response.headers['x-request-id']), 1);
    expect(rows.map((row) => row.details)).toEqual([{ code: 'UNSUPPORTED_MEDIA_TYPE', status: 415 }]);
  });

  it('writes exactly one failure row for a forced 503 and for a transport 400', async () => {
    const unavailable = await testApp.app.inject({
      method: 'POST',
      url: '/__test/areas/unavailable',
      headers: bearer(user),
      payload: {},
    });
    expect(unavailable.statusCode).toBe(503);
    expect((await rowsFor(String(unavailable.headers['x-request-id']), 1)).map((row) => row.details)).toEqual(
      [{ code: 'DEPENDENCY_UNAVAILABLE', status: 503 }],
    );
    const invalid = await testApp.app.inject({
      method: 'POST',
      url: '/__test/areas',
      headers: bearer(user),
      payload: { wrong: 1 },
    });
    expect(invalid.statusCode).toBe(400);
    expect((await rowsFor(String(invalid.headers['x-request-id']), 1)).map((row) => row.details)).toEqual([
      { code: 'VALIDATION_FAILED', status: 400 },
    ]);
  });

  it('adds no duplicate when the service recorded the outcome itself', async () => {
    const response = await testApp.app.inject({
      method: 'POST',
      url: '/__test/areas/recorded',
      headers: bearer(user),
      payload: {},
    });
    expect(response.statusCode).toBe(409);
    await new Promise((resolve) => setTimeout(resolve, 50));
    const rows = await rowsFor(String(response.headers['x-request-id']), 1);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.details).toEqual({ code: 'AREA_ID_CONFLICT' });
  });

  it('records a 403 as denied, with the area as target', async () => {
    const response = await testApp.app.inject({
      method: 'DELETE',
      url: `/__test/areas/${AREA_ID}`,
      headers: bearer(user),
    });
    expect(response.statusCode).toBe(403);
    const rows = await rowsFor(String(response.headers['x-request-id']), 1);
    expect(rows[0]).toMatchObject({
      action: 'area.delete',
      outcome: 'denied',
      targetType: 'area',
      targetId: AREA_ID,
    });
  });

  it('leaves 429s (coalesced ratelimit.hit) and authenticate 401s to their own trails', async () => {
    const ip = uniqueIp();
    await testApp.app.inject({ method: 'POST', url: '/__test/login', remoteAddress: ip, payload: {} });
    const limited = await testApp.app.inject({
      method: 'POST',
      url: '/__test/login',
      remoteAddress: ip,
      payload: {},
    });
    expect(limited.statusCode).toBe(429);
    const unauthenticated = await testApp.app.inject({
      method: 'POST',
      url: '/__test/areas',
      payload: { name: 'x' },
    });
    expect(unauthenticated.statusCode).toBe(401);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(await rowsFor(String(limited.headers['x-request-id']), 0)).toEqual(
      expect.not.arrayContaining([expect.objectContaining({ action: 'auth.login' })]),
    );
    expect(
      audit.find(
        (event) => event.action === 'ratelimit.hit' && event.requestId === limited.headers['x-request-id'],
      ),
    ).toHaveLength(1);
    expect(await rowsFor(String(unauthenticated.headers['x-request-id']), 0)).toEqual([]);
  });

  it('a reused x-request-id cannot suppress the failure row of an overlapping request', async () => {
    gate = deferred();
    const requestId = `dup-${randomUUID()}`;
    const headers = { ...bearer(user), 'x-request-id': requestId };
    const audited = testApp.app.inject({
      method: 'POST',
      url: '/__test/areas/gated-success',
      headers,
      payload: {},
    });
    await waitFor(() => audit.find((event) => event.requestId === requestId).length === 1);

    const failing = await testApp.app.inject({
      method: 'POST',
      url: '/__test/areas/unavailable',
      headers,
      payload: {},
    });
    gate.resolve();
    expect(failing.statusCode).toBe(503);
    expect(failing.headers['x-request-id']).toBe(requestId);
    expect((await audited).statusCode).toBe(200);

    const rows = await rowsFor(requestId, 2);
    expect(rows.map((row) => row.outcome).sort()).toEqual(['failure', 'success']);
    expect(rows.find((row) => row.outcome === 'failure')?.details).toEqual({
      code: 'DEPENDENCY_UNAVAILABLE',
      status: 503,
    });
    expect(testApp.container.auditTracker.wasRecorded(requestId)).toBe(false);
  });

  it('releases tracker entries after the response', async () => {
    const response = await testApp.app.inject({
      method: 'POST',
      url: '/__test/areas/recorded',
      headers: bearer(user),
      payload: {},
    });
    expect(testApp.container.auditTracker.wasRecorded(String(response.headers['x-request-id']))).toBe(false);
  });
});
