/** D-8: an email address works as a username, stays unique case-insensitively, and signs in with any case spelling. */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { testRunId } from '../../helpers/test-app.js';
import { PASSWORD, authBody, createAuthTestApp, login, register } from './auth-test-kit.js';
import type { AuthTestApp } from './auth-test-kit.js';

let testApp: AuthTestApp;

beforeAll(async () => {
  testApp = await createAuthTestApp();
});

afterAll(async () => {
  await testApp.close();
});

describe('email as username (D-8)', () => {
  it('registers with an email, rejects a case-variant duplicate, and signs in with any case', async () => {
    const email = `moshe.${testRunId()}@example.com`;

    const created = await register(testApp, { username: email, password: PASSWORD, displayName: 'moshe' });
    expect(created.statusCode).toBe(201);
    expect(authBody(created).user.username).toBe(email);

    const duplicate = await register(testApp, {
      username: email.toUpperCase(),
      password: PASSWORD,
      displayName: 'x',
    });
    expect(duplicate.statusCode).toBe(409);

    const signedIn = await login(testApp, email.toUpperCase(), PASSWORD);
    expect(signedIn.statusCode).toBe(200);
    expect(authBody(signedIn).user.username).toBe(email);
  });

  it('still rejects malformed addresses at the boundary', async () => {
    const response = await register(testApp, {
      username: 'moshe@localhost',
      password: PASSWORD,
      displayName: 'moshe',
    });
    expect(response.statusCode).toBe(400);
  });
});
