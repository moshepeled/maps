/**
 * What happens after a session revocation has been COMMITTED (SPEC section 6.2 "Session management"): the database row is
 * authoritative; then the session is marked in Redis (so `authenticate` rejects its still-valid access token at once)
 * and a `sessions` bus event tells every gateway to close its sockets with 4401. Both steps are best effort - a Redis
 * failure is logged at warn and never fails the request, because the gateway re-validation loop and the <= 15-min access
 * token expiry close the gap. The outcome is returned so the user-admin CLI can report failed steps (exit 1).
 */
import type { SessionRevocationStore } from '../../infra/auth/revocations.js';
import type { EventBus } from '../../infra/events/types.js';
import type { Logger } from '../../infra/logger.js';
import type { RevokedReason } from './sessions.repository.js';

export interface RevokedSession {
  sessionId: string;
  userId: string;
  reason: RevokedReason;
}

export interface RevocationDelivery {
  sessionId: string;
  /** `revocations.markRevoked` succeeded. */
  marked: boolean;
  /** The `sessions` event reached Redis (`events.publish` resolved true). */
  published: boolean;
}

export interface RevocationNotifier {
  /** Never throws. Call only after the revoking transaction committed. */
  notify(revoked: RevokedSession): Promise<RevocationDelivery>;
}

export interface RevocationNotifierDeps {
  revocations: SessionRevocationStore;
  events: EventBus;
  logger: Logger;
}

export function createRevocationNotifier({
  revocations,
  events,
  logger,
}: RevocationNotifierDeps): RevocationNotifier {
  return {
    async notify({ sessionId, userId, reason }) {
      let marked = true;
      try {
        await revocations.markRevoked(sessionId);
      } catch (error) {
        marked = false;
        logger.warn(
          { err: error, sessionId, reason },
          'could not mark the session revoked in Redis; the database revocation stands and its access token ' +
            'stays usable until it expires',
        );
      }
      // publish() never throws: it logs and counts its own failures.
      const published = await events.publish('sessions', { kind: 'revoked', sessionId, userId, reason });
      return { sessionId, marked, published };
    },
  };
}
