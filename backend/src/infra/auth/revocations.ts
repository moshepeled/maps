/**
 * Immediate session revocation (SPEC section 6.2): logout/revoke writes `snap:revoked:<sessionId>` with the access-token TTL
 * so `authenticate` rejects the still-valid JWT at once. The DB revocation is authoritative: `markRevoked` THROWS when
 * Redis fails (the auth service logs and continues; the user-admin CLI exits 1), `isRevoked` fails open with a warning.
 */
import type { Clock } from '../clock.js';
import { KeyedThrottle } from '../keyed-throttle.js';
import type { Logger } from '../logger.js';
import type { RedisClients } from '../redis/client.js';
import type { RedisKeys } from '../redis/keys.js';

export interface SessionRevocationStore {
  /** TTL = ACCESS_TOKEN_TTL_S. Throws when Redis fails. */
  markRevoked(sessionId: string): Promise<void>;
  /** Fail-open: false (and a throttled warning) when Redis is down. */
  isRevoked(sessionId: string): Promise<boolean>;
}

export interface RevocationStoreDeps {
  redis: RedisClients;
  keys: RedisKeys;
  clock: Clock;
  logger: Logger;
  /** ACCESS_TOKEN_TTL_S: after that the JWT is expired anyway. */
  ttlS: number;
}

const WARN_INTERVAL_MS = 30_000;

export function createRevocationStore({
  redis,
  keys,
  clock,
  logger,
  ttlS,
}: RevocationStoreDeps): SessionRevocationStore {
  const warnings = new KeyedThrottle(WARN_INTERVAL_MS, 1);
  return {
    async markRevoked(sessionId) {
      await redis.cmd.set(keys.revokedSession(sessionId), '1', 'EX', ttlS);
    },

    async isRevoked(sessionId) {
      try {
        return (await redis.cmd.exists(keys.revokedSession(sessionId))) === 1;
      } catch (error) {
        if (warnings.shouldFire('isRevoked', clock.now())) {
          logger.warn({ err: error }, 'revocation check unavailable (Redis); failing open until it recovers');
        }
        return false;
      }
    },
  };
}
