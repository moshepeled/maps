import { ProblemSchema } from '@snapland/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createTestApp } from '../../helpers/test-app.js';
import type { TestApp } from '../../helpers/test-app.js';
import { bearer, createUser } from '../../helpers/users.js';
import type { TestUser } from '../../helpers/users.js';

let testApp: TestApp;
let user: TestUser;

beforeAll(async () => {
  testApp = await createTestApp();
  user = await createUser(testApp.container);
});

afterAll(async () => {
  await testApp.close();
});

const REPORT = {
  kind: 'ws_close',
  code: 4400,
  message: 'closed by server',
  context: { attempt: 3, limited: false },
  appVersion: '1.0.0',
};

describe('POST /api/v1/client-errors (section 6.4, R23)', () => {
  it('accepts a report with 204, logs it at warn with clientError: true and counts it', async () => {
    testApp.logs.clear();
    const response = await testApp.app.inject({
      method: 'POST',
      url: '/api/v1/client-errors',
      headers: bearer(user),
      payload: { ...REPORT, message: `bad${String.fromCharCode(0)} frame\n  received` },
    });
    expect(response.statusCode).toBe(204);
    expect(response.body).toBe('');
    const [line] = testApp.logs.find((entry) => entry['clientError'] === true);
    expect(line).toMatchObject({
      level: 'warn',
      kind: 'ws_close',
      code: 4400,
      message: 'bad frame received',
      userId: user.id,
    });
    const metrics = (await testApp.app.inject({ method: 'GET', url: '/metrics' })).body;
    expect(metrics).toMatch(/snapland_client_errors_total\{[^}]*kind="ws_close"[^}]*\} 1/);
  });

  it('requires authentication', async () => {
    const response = await testApp.app.inject({
      method: 'POST',
      url: '/api/v1/client-errors',
      payload: REPORT,
    });
    expect(response.statusCode).toBe(401);
    expect(ProblemSchema.parse(response.json()).code).toBe('UNAUTHENTICATED');
  });

  it('rejects an invalid report with 400 and a body over 8 KiB with 413', async () => {
    const invalid = await testApp.app.inject({
      method: 'POST',
      url: '/api/v1/client-errors',
      headers: bearer(user),
      payload: { ...REPORT, kind: 'other' },
    });
    expect(invalid.statusCode).toBe(400);
    const large = await testApp.app.inject({
      method: 'POST',
      url: '/api/v1/client-errors',
      headers: bearer(user),
      payload: { ...REPORT, context: { blob: 'x'.repeat(9000) } },
    });
    expect(large.statusCode).toBe(413);
  });
});
