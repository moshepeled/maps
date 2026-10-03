/**
 * Brute-force protection of `POST /auth/login` (SPEC section 6.2, section 10.1): two failure counters in Redis, a 900 s window from
 * the first counted attempt, both cleared by a successful login:
 *  - `rl:login:ui:<sha1(lower(username) + "|" + ip)>` - 5 failures per (username, IP) -> 429 `scope: login`;
 *  - `rl:login:u:<sha1(lower(username))>` - 50 failures per username across all IPs.
 * Hashing the key material keeps usernames and IPs out of Redis key names.
 *
 * Each attempt is counted BEFORE its password is verified, atomically with the lockout check (one Lua script): a
 * check that ran first and an increment that ran after the ~50 ms argon2 verification would let every attempt of a
 * parallel burst pass the check. A wrong guess leaves its count in place; a success clears both counters (`reset`);
 * anything else (disabled account, database or hashing error) gives the count back (`release`).
 *
 * Redis failures fail OPEN (logged, throttled): the per-IP `auth` route limit still bounds guessing, and an outage of
 * the counters must not become an outage of login.
 */
import { createHash } from 'node:crypto';

import type { Clock } from '../../infra/clock.js';
import { KeyedThrottle } from '../../infra/keyed-throttle.js';
import type { Logger } from '../../infra/logger.js';
import type { RedisClients } from '../../infra/redis/client.js';
import type { RedisKeys } from '../../infra/redis/keys.js';
import { LuaScript } from '../../infra/redis/lua.js';
import type { CanonicalUsername } from './username.js';

export const LOGIN_FAILURE_WINDOW_S = 900;
export const LOGIN_FAILURE_LIMITS = { perUserIp: 5, perUser: 50 } as const;

/** Stand-in for a request whose IP could not be validated (it still gets a (username, IP) bucket). */
const UNKNOWN_IP = 'unknown';
const WARN_INTERVAL_MS = 30_000;

/**
 * KEYS[1] = (username, IP) counter, KEYS[2] = username counter; ARGV[1] = per-(username, IP) limit, ARGV[2] =
 * per-username limit, ARGV[3] = window (s). Counts the attempt in BOTH counters only when neither has reached its
 * limit - the same `count < limit` rule as `evaluateLockout` - so a refused attempt never extends a lockout. The window
 * starts at the first counted attempt and is never extended (EXPIRE ... NX).
 * Reply: {userIpCount, userIpPttlMs, userCount, userPttlMs}, the counts as they were BEFORE this attempt.
 */
export const ADMIT_LOGIN_ATTEMPT_LUA = `
local userIp = tonumber(redis.call('GET', KEYS[1]) or '0')
local user = tonumber(redis.call('GET', KEYS[2]) or '0')
if userIp < tonumber(ARGV[1]) and user < tonumber(ARGV[2]) then
  redis.call('INCR', KEYS[1])
  redis.call('EXPIRE', KEYS[1], ARGV[3], 'NX')
  redis.call('INCR', KEYS[2])
  redis.call('EXPIRE', KEYS[2], ARGV[3], 'NX')
end
return {userIp, redis.call('PTTL', KEYS[1]), user, redis.call('PTTL', KEYS[2])}
`;

/**
 * KEYS[1], KEYS[2] = the two counters. Gives one counted attempt back: never below zero and never creates a key (a
 * success may have cleared the counters meanwhile); a counter that reaches zero is deleted, which also ends its window.
 */
export const RELEASE_LOGIN_ATTEMPT_LUA = `
for _, key in ipairs(KEYS) do
  local count = tonumber(redis.call('GET', key) or '0')
  if count > 1 then
    redis.call('DECR', key)
  elseif count == 1 then
    redis.call('DEL', key)
  end
end
return 1
`;

const ADMIT_LOGIN_ATTEMPT = new LuaScript(ADMIT_LOGIN_ATTEMPT_LUA);
const RELEASE_LOGIN_ATTEMPT = new LuaScript(RELEASE_LOGIN_ATTEMPT_LUA);

export interface CounterState {
  /** Attempts counted in the current window (0 when the key does not exist). */
  count: number;
  /** Remaining window in ms (Redis PTTL: -2 = no key, -1 = no expiry). */
  ttlMs: number;
}

export interface LoginLockout {
  locked: true;
  counter: 'user_ip' | 'user';
  limit: number;
  retryAfterMs: number;
}

export type LockoutDecision = { locked: false } | LoginLockout;

/**
 * The outcome of `admit`: refused (locked), or allowed. `reserved` says whether the attempt was counted in Redis
 * (false only when Redis was unavailable and the counters failed open) - only a reserved attempt can be released.
 */
export type LoginAdmission = { locked: false; reserved: boolean } | LoginLockout;

function remainingMs(state: CounterState): number {
  return state.ttlMs > 0 ? state.ttlMs : LOGIN_FAILURE_WINDOW_S * 1000;
}

/**
 * Pure: locked once a counter has reached its limit, i.e. the (limit + 1)-th attempt is refused. When both counters
 * are exhausted the longer wait is reported, so a retry after `retryAfterMs` is not refused again.
 */
export function evaluateLockout(userIp: CounterState, user: CounterState): LockoutDecision {
  const candidates: Omit<LoginLockout, 'locked'>[] = [];
  if (userIp.count >= LOGIN_FAILURE_LIMITS.perUserIp) {
    candidates.push({
      counter: 'user_ip',
      limit: LOGIN_FAILURE_LIMITS.perUserIp,
      retryAfterMs: remainingMs(userIp),
    });
  }
  if (user.count >= LOGIN_FAILURE_LIMITS.perUser) {
    candidates.push({
      counter: 'user',
      limit: LOGIN_FAILURE_LIMITS.perUser,
      retryAfterMs: remainingMs(user),
    });
  }
  const longest = candidates.sort((a, b) => b.retryAfterMs - a.retryAfterMs)[0];
  return longest === undefined ? { locked: false } : { locked: true, ...longest };
}

/**
 * The admission decided by the script's reply (Lua integers reach ioredis as JS integers; anything else is a
 * script/protocol mismatch, thrown so the counters fail open). The script counted the attempt exactly when
 * `evaluateLockout` finds no exhausted counter (same limits, same comparison), so an admitted attempt is reserved.
 */
export function toAdmission(reply: unknown): LoginAdmission {
  if (!Array.isArray(reply) || reply.length !== 4 || !reply.every((item) => Number.isInteger(item))) {
    throw new Error('login failure counters: unexpected Lua reply (expected 4 integers)');
  }
  const [userIpCount, userIpTtlMs, userCount, userTtlMs] = reply as [number, number, number, number];
  const decision = evaluateLockout(
    { count: userIpCount, ttlMs: userIpTtlMs },
    { count: userCount, ttlMs: userTtlMs },
  );
  return decision.locked ? decision : { locked: false, reserved: true };
}

function sha1Hex(text: string): string {
  return createHash('sha1').update(text).digest('hex');
}

export interface LoginFailureKeys {
  userIp: string;
  user: string;
}

/** The two Redis keys of a (username, IP) pair; the name is already folded (`CanonicalUsername`), never again here. */
export function loginFailureKeys(
  keys: RedisKeys,
  username: CanonicalUsername,
  ip: string | null,
): LoginFailureKeys {
  return {
    userIp: keys.loginFailuresUserIp(sha1Hex(`${username}|${ip ?? UNKNOWN_IP}`)),
    user: keys.loginFailuresUser(sha1Hex(username)),
  };
}

export interface LoginFailureCounter {
  /**
   * Atomically refuses a locked (username, IP) or username, or counts this attempt as a failure in advance.
   * Never throws: `{ locked: false, reserved: false }` when Redis is unavailable.
   */
  admit(username: CanonicalUsername, ip: string | null): Promise<LoginAdmission>;
  /** The attempt succeeded: clears both counters. Never throws. */
  reset(username: CanonicalUsername, ip: string | null): Promise<void>;
  /** The attempt was not a failed guess (disabled account, internal error): gives its count back. Never throws. */
  release(username: CanonicalUsername, ip: string | null): Promise<void>;
}

export interface RedisLoginFailureCounterDeps {
  redis: RedisClients;
  keys: RedisKeys;
  clock: Clock;
  logger: Logger;
}

export function createLoginFailureCounter({
  redis,
  keys,
  clock,
  logger,
}: RedisLoginFailureCounterDeps): LoginFailureCounter {
  // One throttle key per operation (three keys at most).
  const warnings = new KeyedThrottle(WARN_INTERVAL_MS);
  const warnUnavailable = (operation: string, error: unknown): void => {
    if (warnings.shouldFire(operation, clock.now())) {
      logger.warn(
        { err: error, operation },
        'login failure counters unavailable (Redis); failing open until it recovers',
      );
    }
  };

  return {
    async admit(username, ip) {
      const { userIp, user } = loginFailureKeys(keys, username, ip);
      try {
        const reply = await ADMIT_LOGIN_ATTEMPT.run(
          redis.cmd,
          [userIp, user],
          [LOGIN_FAILURE_LIMITS.perUserIp, LOGIN_FAILURE_LIMITS.perUser, LOGIN_FAILURE_WINDOW_S],
        );
        return toAdmission(reply);
      } catch (error) {
        warnUnavailable('admit', error);
        return { locked: false, reserved: false };
      }
    },

    async reset(username, ip) {
      const { userIp, user } = loginFailureKeys(keys, username, ip);
      try {
        await redis.cmd.del(userIp, user);
      } catch (error) {
        warnUnavailable('reset', error);
      }
    },

    async release(username, ip) {
      const { userIp, user } = loginFailureKeys(keys, username, ip);
      try {
        await RELEASE_LOGIN_ATTEMPT.run(redis.cmd, [userIp, user], []);
      } catch (error) {
        warnUnavailable('release', error);
      }
    },
  };
}
