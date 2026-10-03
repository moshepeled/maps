/**
 * Regression suite of the T1 round-2 QA findings on login usernames. `LoginRequest.username` is any 1..128-character
 * string (the shared contract); the service folds it ONCE (`canonicalUsername`, username.ts) and uses that one value for
 * both the failure counters and the account lookup.
 *
 * T1-QA2-01 - the counters used to be keyed by JavaScript's fold and the account found by PostgreSQL's. The two
 * disagree on U+0130 'İ' (PostgreSQL -> 'i', JavaScript -> 'i' + U+0307), so a name with an 'i' spelled 'İ' reached the
 * SAME account through fresh counters and multiplied both section 6.2 limits. Now a name outside the registration pattern
 * never reaches an account (not even with the correct password), and every ASCII case spelling shares one set of
 * counters.
 *
 * T1-QA2-02 - a NUL character cannot be sent to PostgreSQL as text (SQLSTATE 22021), which made the public endpoint
 * answer 500. Such a name no longer reaches SQL: it gets the uniform 401 INVALID_CREDENTIALS body.
 */
import { verify } from '@node-rs/argon2';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { DUMMY_PASSWORD_HASH } from '../../../src/modules/auth/index.js';
import { LOGIN_FAILURE_LIMITS } from '../../../src/modules/auth/login-failures.js';
import { uniqueIp } from '../../helpers/net.js';
import { nextUsername } from '../../helpers/users.js';
import {
  PASSWORD,
  auditEventsOf,
  authBody,
  createAuthTestApp,
  existingKeyCount,
  failureCounterKeys,
  login,
  problem,
  registerUser,
} from './auth-test-kit.js';
import type { AuthTestApp, RegisteredUser } from './auth-test-kit.js';

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

/** The two non-ASCII letters PostgreSQL (en_US.utf8) folds to ASCII; each once reached the account it imitates. */
const LOOKALIKES = [
  { label: 'U+0130 for an i', prefix: 'qai', ascii: 'i', lookalike: 'İ' },
  { label: 'U+212A (Kelvin sign) for a k', prefix: 'qak', ascii: 'k', lookalike: 'K' },
] as const;

type Lookalike = (typeof LOOKALIKES)[number];

/** A registered user, and the same name with its first `ascii` letter replaced by the look-alike. */
async function userWithLookalike(spec: Lookalike): Promise<{ user: RegisteredUser; variant: string }> {
  const user = await registerUser(testApp, { username: nextUsername(spec.prefix) });
  return { user, variant: user.username.replace(spec.ascii, spec.lookalike) };
}

/** A fresh pinned request id: responses that share it must have byte-identical bodies. */
function pinnedRequestId(): Record<string, string> {
  return { 'x-request-id': `pinned-${nextUsername('rq')}` };
}

/**
 * Asserts the unknown-user treatment: 401 INVALID_CREDENTIALS, the body byte-identical to a reference unknown-user
 * response with the same request id, one verification against the dummy hash, and the anonymous audit failure row.
 */
async function expectUnknownUserTreatment(username: string, ip: string = uniqueIp()): Promise<void> {
  const headers = pinnedRequestId();
  const reference = await login(testApp, nextUsername('ghost'), PASSWORD, { headers });

  const argonVerify = vi.mocked(verify);
  argonVerify.mockClear();
  const response = await login(testApp, username, PASSWORD, { ip, headers });
  expect(argonVerify).toHaveBeenCalledTimes(1);
  expect(argonVerify).toHaveBeenCalledWith(DUMMY_PASSWORD_HASH, PASSWORD);

  expect(response.statusCode).toBe(401);
  expect(problem(response).code).toBe('INVALID_CREDENTIALS');
  expect(response.rawPayload.equals(reference.rawPayload)).toBe(true);
  // Two rows under the pinned id: the reference unknown user's and this attempt's, identical in kind.
  expect(auditEventsOf(testApp, response)).toEqual([
    expect.objectContaining({
      action: 'auth.login',
      outcome: 'failure',
      actorId: null,
      targetType: 'user',
      targetId: null,
      details: { reason: 'invalid_credentials' },
    }),
    expect.objectContaining({
      action: 'auth.login',
      outcome: 'failure',
      actorId: null,
      targetType: 'user',
      targetId: null,
      details: { reason: 'invalid_credentials' },
    }),
  ]);
}

describe('one set of failure counters per account (T1-QA2-01)', () => {
  it('every ASCII case spelling of a name shares the (username, IP) counter and signs in to the same account', async () => {
    const user = await registerUser(testApp, { username: nextUsername('qacase') });
    const spellings = [user.username, user.username.toUpperCase(), `Q${user.username.slice(1)}`];
    const ip = uniqueIp();
    for (let attempt = 0; attempt < LOGIN_FAILURE_LIMITS.perUserIp; attempt += 1) {
      const spelling = spellings[attempt % spellings.length] ?? user.username;
      expect((await login(testApp, spelling, `wrong-${attempt}`, { ip })).statusCode).toBe(401);
    }

    const locked = await login(testApp, user.username.toUpperCase(), PASSWORD, { ip });
    expect(locked.statusCode).toBe(429);
    expect(problem(locked)).toMatchObject({ code: 'RATE_LIMITED', scope: 'login' });

    const elsewhere = await login(testApp, user.username.toUpperCase(), PASSWORD, { ip: uniqueIp() });
    expect(elsewhere.statusCode).toBe(200);
    expect(authBody(elsewhere).user.id).toBe(user.auth.user.id);
  });

  it.each(LOOKALIKES)(
    'a name with $label never reaches the account, even with the correct password',
    async (spec) => {
      const { user, variant } = await userWithLookalike(spec);
      const ip = uniqueIp();

      await expectUnknownUserTreatment(variant, ip);

      // Nothing was counted for the account it imitates, and the account itself still signs in.
      expect(await existingKeyCount(testApp, failureCounterKeys(testApp, user.username, ip))).toBe(0);
      expect((await login(testApp, user.username, PASSWORD, { ip })).statusCode).toBe(200);
    },
  );
});

/** Login names with U+0000, built from a registered user's name. */
const NUL_NAMES: { label: string; build: (registered: string) => string }[] = [
  { label: 'a trailing NUL after a real name', build: (registered) => `${registered}\u0000` },
  { label: 'a lone NUL', build: () => '\u0000' },
  { label: 'a NUL inside a name', build: () => 'x\u0000y' },
];

describe('usernames PostgreSQL cannot store never reach SQL (T1-QA2-02)', () => {
  it.each(NUL_NAMES)('$label gets the uniform 401 INVALID_CREDENTIALS, not 500', async ({ build }) => {
    const user = await registerUser(testApp);
    await expectUnknownUserTreatment(build(user.username));
  });

  it('a username at the contract maximum (128 characters) is an unknown user, not a 400 or 500', async () => {
    await expectUnknownUserTreatment('a'.repeat(128));
  });
});
