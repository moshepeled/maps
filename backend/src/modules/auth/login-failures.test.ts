import { describe, expect, it } from 'vitest';

import { createRedisKeys } from '../../infra/redis/keys.js';
import { LOGIN_FAILURE_LIMITS, evaluateLockout, loginFailureKeys, toAdmission } from './login-failures.js';
import { canonicalUsername } from './username.js';
import type { CanonicalUsername } from './username.js';

const NONE = { count: 0, ttlMs: -2 };

describe('evaluateLockout (section 6.2 brute-force counters)', () => {
  it('allows up to 5 failures per (username, IP) and refuses the 6th attempt', () => {
    expect(evaluateLockout({ count: 4, ttlMs: 60_000 }, { count: 4, ttlMs: 60_000 })).toEqual({
      locked: false,
    });
    expect(evaluateLockout({ count: 5, ttlMs: 60_000 }, { count: 5, ttlMs: 60_000 })).toEqual({
      locked: true,
      counter: 'user_ip',
      limit: LOGIN_FAILURE_LIMITS.perUserIp,
      retryAfterMs: 60_000,
    });
  });

  it('refuses every IP once the username reached 50 failures', () => {
    expect(evaluateLockout(NONE, { count: 50, ttlMs: 120_000 })).toEqual({
      locked: true,
      counter: 'user',
      limit: LOGIN_FAILURE_LIMITS.perUser,
      retryAfterMs: 120_000,
    });
    expect(evaluateLockout(NONE, { count: 49, ttlMs: 120_000 })).toEqual({ locked: false });
  });

  it('reports the longer wait when both counters are exhausted', () => {
    const decision = evaluateLockout({ count: 5, ttlMs: 10_000 }, { count: 50, ttlMs: 500_000 });
    expect(decision).toMatchObject({ locked: true, counter: 'user', retryAfterMs: 500_000 });
  });

  it('falls back to the full window when the key has no TTL', () => {
    expect(evaluateLockout({ count: 7, ttlMs: -1 }, NONE)).toMatchObject({ retryAfterMs: 900_000 });
  });
});

describe('toAdmission (the atomic admission script reply {userIpCount, userIpPttl, userCount, userPttl})', () => {
  it.each([
    [
      'a counted attempt below both limits (reserved: it can be given back)',
      [4, 1000, 49, 1000],
      { locked: false, reserved: true },
    ],
    [
      'the 6th attempt per (username, IP), refused with the remaining window',
      [5, 42_000, 0, -2],
      { locked: true, counter: 'user_ip', limit: LOGIN_FAILURE_LIMITS.perUserIp, retryAfterMs: 42_000 },
    ],
    [
      'the username at 50 attempts, refused from every IP',
      [0, -2, 50, 300_000],
      { locked: true, counter: 'user', limit: LOGIN_FAILURE_LIMITS.perUser, retryAfterMs: 300_000 },
    ],
  ])('decides %s', (_label, reply, expected) => {
    expect(toAdmission(reply)).toEqual(expected);
  });

  it.each([
    [null],
    ['OK'],
    [[1, 2, 3]],
    [[1, 2, 3, 4, 5]],
    [[1, '2', 3, 4]],
    [[1, 2, 3, null]],
    [[1, 2, 3.5, 4]],
  ])('throws on an unexpected reply %j (the counters then fail open)', (reply) => {
    expect(() => toAdmission(reply)).toThrow(/login failure counters/);
  });
});

/** The canonical form of a name that is known to match the pattern (a test precondition). */
function canonical(raw: string): CanonicalUsername {
  const name = canonicalUsername(raw);
  if (name === null) throw new Error(`test username ${raw} does not match the registration pattern`);
  return name;
}

describe('loginFailureKeys', () => {
  const keys = createRedisKeys('snap:');

  it('hashes lower(username)|ip and lower(username) under the rl:login prefixes', () => {
    const upper = loginFailureKeys(keys, canonical('Alice'), '10.0.0.1');
    const lower = loginFailureKeys(keys, canonical('alice'), '10.0.0.1');
    expect(upper).toEqual(lower);
    expect(lower.userIp).toMatch(/^snap:rl:login:ui:[0-9a-f]{40}$/);
    expect(lower.user).toMatch(/^snap:rl:login:u:[0-9a-f]{40}$/);
    expect(lower.userIp).not.toContain('alice');
  });

  it('gives each IP its own (username, IP) bucket but one username bucket', () => {
    const alice = canonical('alice');
    const a = loginFailureKeys(keys, alice, '10.0.0.1');
    const b = loginFailureKeys(keys, alice, '10.0.0.2');
    const unknown = loginFailureKeys(keys, alice, null);
    expect(a.userIp).not.toBe(b.userIp);
    expect(unknown.userIp).not.toBe(a.userIp);
    expect(a.user).toBe(b.user);
  });
});
