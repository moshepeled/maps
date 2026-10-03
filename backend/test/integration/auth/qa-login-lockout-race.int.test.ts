/**
 * Regression suite of QA finding T1-QA1-01: the login failure limits of SPEC section 6.2 / section 10.1 must hold under concurrency,
 * not only for sequential attempts. The counters were once read before the password verification and incremented only
 * after it, so every attempt of a parallel burst passed the check. Each attempt is now counted atomically with the
 * lockout check before its password is verified, so exactly `limit` attempts of any burst are evaluated and the rest are
 * refused with 429 scope login - per (username, IP), and per username across IPs (the distributed-guessing bound).
 */
import type { LightMyRequestResponse as InjectResponse } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { LOGIN_FAILURE_LIMITS } from '../../../src/modules/auth/login-failures.js';
import { uniqueIp } from '../../helpers/net.js';
import { createAuthTestApp, login, problem, registerUser } from './auth-test-kit.js';
import type { AuthTestApp } from './auth-test-kit.js';

let testApp: AuthTestApp;

beforeAll(async () => {
  testApp = await createAuthTestApp();
});

afterAll(async () => {
  await testApp.close();
});

/** How many responses have each status, e.g. { 401: 5, 429: 5 }. */
function statusCounts(responses: readonly InjectResponse[]): Record<number, number> {
  const counts: Record<number, number> = {};
  for (const { statusCode } of responses) counts[statusCode] = (counts[statusCode] ?? 0) + 1;
  return counts;
}

describe('login lockout under concurrency (QA T1-QA1-01)', () => {
  it('evaluates exactly 5 wrong passwords per (username, IP) when 10 arrive at once; the rest get 429', async () => {
    const user = await registerUser(testApp);
    const ip = uniqueIp();
    const burst = 2 * LOGIN_FAILURE_LIMITS.perUserIp;
    const responses = await Promise.all(
      Array.from({ length: burst }, (_, attempt) =>
        login(testApp, user.username, `wrong-${attempt}`, { ip }),
      ),
    );

    expect(statusCounts(responses)).toEqual({
      401: LOGIN_FAILURE_LIMITS.perUserIp,
      429: burst - LOGIN_FAILURE_LIMITS.perUserIp,
    });
    for (const refused of responses.filter((response) => response.statusCode === 429)) {
      expect(problem(refused)).toMatchObject({
        code: 'RATE_LIMITED',
        scope: 'login',
        limit: LOGIN_FAILURE_LIMITS.perUserIp,
      });
    }
  });

  it('evaluates exactly 50 wrong passwords per username when 55 arrive at once from 55 addresses', async () => {
    const user = await registerUser(testApp);
    const burst = LOGIN_FAILURE_LIMITS.perUser + 5;
    const responses = await Promise.all(
      Array.from({ length: burst }, (_, attempt) =>
        login(testApp, user.username, `wrong-${attempt}`, { ip: uniqueIp() }),
      ),
    );

    expect(statusCounts(responses)).toEqual({ 401: LOGIN_FAILURE_LIMITS.perUser, 429: 5 });
    for (const refused of responses.filter((response) => response.statusCode === 429)) {
      expect(problem(refused)).toMatchObject({ scope: 'login', limit: LOGIN_FAILURE_LIMITS.perUser });
    }
  });
});
