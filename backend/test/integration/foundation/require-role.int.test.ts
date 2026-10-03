/**
 * `app.requireRole('admin')` (SPEC section 3.3, section 10.7.5): the CURRENT role and disabled flag are read through
 * `container.users` on every request, so revoke-admin and disable take effect on the next request even though the
 * caller's access token (which still says `role: admin`) stays valid until it expires.
 */
import { ProblemSchema } from '@snapland/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { sql } from '../../../src/infra/db/types.js';
import { createTestApp } from '../../helpers/test-app.js';
import type { TestApp } from '../../helpers/test-app.js';
import { bearer, createUser, disableUserInDb } from '../../helpers/users.js';

const SET_ROLE = sql('testRequireRole.setRole', 'UPDATE users SET role = $2 WHERE id = $1');

let testApp: TestApp;

beforeAll(async () => {
  testApp = await createTestApp({
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

async function callAdminRoute(headers: Record<string, string> = {}) {
  const response = await testApp.app.inject({ method: 'GET', url: '/__test/admin-only', headers });
  return { status: response.statusCode, body: response.json<unknown>() };
}

function problemCode(body: unknown): string {
  return ProblemSchema.parse(body).code;
}

describe('requireRole("admin") (section 10.7.5)', () => {
  it('rejects a request without a token with 401 (authenticate runs first)', async () => {
    const { status, body } = await callAdminRoute();
    expect(status).toBe(401);
    expect(problemCode(body)).toBe('UNAUTHENTICATED');
  });

  it('rejects a regular user with 403 FORBIDDEN and admits an admin', async () => {
    const user = await createUser(testApp.container);
    const admin = await createUser(testApp.container, { role: 'admin' });

    const denied = await callAdminRoute(bearer(user));
    expect(denied.status).toBe(403);
    expect(problemCode(denied.body)).toBe('FORBIDDEN');

    const allowed = await callAdminRoute(bearer(admin));
    expect(allowed.status).toBe(200);
    expect(allowed.body).toEqual({ ok: true });
  });

  it('revoke-admin takes effect on the next request with the same, still valid token', async () => {
    const admin = await createUser(testApp.container, { role: 'admin' });
    expect((await callAdminRoute(bearer(admin))).status).toBe(200);

    await testApp.container.db.query(SET_ROLE, [admin.id, 'user']);

    const after = await callAdminRoute(bearer(admin));
    expect(after.status).toBe(403);
    expect(problemCode(after.body)).toBe('FORBIDDEN');
  });

  it('disabling an admin takes effect on the next request with the same, still valid token', async () => {
    const admin = await createUser(testApp.container, { role: 'admin' });
    expect((await callAdminRoute(bearer(admin))).status).toBe(200);

    await disableUserInDb(testApp.container, admin.id);

    const after = await callAdminRoute(bearer(admin));
    expect(after.status).toBe(403);
    expect(problemCode(after.body)).toBe('FORBIDDEN');
  });

  it('rejects an admin created disabled', async () => {
    const admin = await createUser(testApp.container, { role: 'admin', disabled: true });
    expect((await callAdminRoute(bearer(admin))).status).toBe(403);
  });
});
