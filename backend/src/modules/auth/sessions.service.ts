/**
 * The signed-in user's sessions (SPEC section 6.2, section 7.2): the current one (`me`), the active list (a read - request log
 * only, never an audit row), revoking one of them (`user_revoked`: another user's or an unknown session is a 404 that
 * does not reveal whether the id exists; revoking an own session twice is a no-op success) and one-time WebSocket
 * tickets.
 */
import type { MeResponse, SessionListResponse, WsTicketResponse } from '@snapland/shared';

import type { WsTicketStore } from '../../infra/auth/ws-tickets.js';
import type { AuditEvent, AuditLogger } from '../../infra/audit/types.js';
import type { Db } from '../../infra/db/types.js';
import { NotFoundError, ServiceUnavailableError, UnauthorizedError } from '../../infra/http/errors.js';
import type { ActorContext } from '../../infra/http/request-context.js';
import type { Logger } from '../../infra/logger.js';
import { actorAuditFields, requireSessionActor } from './auth-context.js';
import type { SessionActor } from './auth-context.js';
import { toSessionDto, toUserDto } from './auth.mapper.js';
import type { RevocationNotifier } from './revocation-notifier.js';
import {
  findActiveSessionWithUser,
  isSessionOwnedBy,
  listActiveSessions,
  revokeSession,
} from './sessions.repository.js';
import type { SessionWithOwner } from './sessions.repository.js';

/** Clients retry a failed ticket request after this long (Redis outage). */
const WS_TICKET_RETRY_AFTER_S = 5;

export interface SessionsServiceDeps {
  db: Db;
  audit: AuditLogger;
  notifier: RevocationNotifier;
  wsTickets: WsTicketStore;
  logger: Logger;
}

export class SessionsService {
  readonly #deps: SessionsServiceDeps;

  constructor(deps: SessionsServiceDeps) {
    this.#deps = deps;
  }

  async me(actor: ActorContext): Promise<MeResponse> {
    const caller = requireSessionActor(actor);
    const found = await this.#activeSession(caller);
    return { user: toUserDto(found.owner), session: toSessionDto(found.session, caller.sessionId) };
  }

  async list(actor: ActorContext): Promise<SessionListResponse> {
    const { userId, sessionId } = requireSessionActor(actor);
    const sessions = await listActiveSessions(this.#deps.db, userId);
    return { items: sessions.map((session) => toSessionDto(session, sessionId)) };
  }

  async revoke(actor: ActorContext, targetSessionId: string): Promise<void> {
    const caller = requireSessionActor(actor);
    const { db, notifier } = this.#deps;
    const event = {
      action: 'auth.session_revoke',
      targetType: 'session',
      targetId: targetSessionId,
    } as const;
    const revoked = await revokeSession(db, targetSessionId, caller.userId, 'user_revoked');
    if (revoked) {
      await notifier.notify({ sessionId: targetSessionId, userId: caller.userId, reason: 'user_revoked' });
      this.#audit(caller, { ...event, outcome: 'success', details: { revokedSessionId: targetSessionId } });
      return;
    }
    if (await isSessionOwnedBy(db, targetSessionId, caller.userId)) {
      this.#audit(caller, {
        ...event,
        outcome: 'success',
        details: { revokedSessionId: targetSessionId, alreadyRevoked: true },
      });
      return;
    }
    this.#audit(caller, { ...event, outcome: 'failure', details: { code: 'NOT_FOUND', status: 404 } });
    throw new NotFoundError('NOT_FOUND', 'No such session.');
  }

  /** The ticket carries the CURRENT profile and role (read here), so the WS upgrade needs no user lookup (section 7.2). */
  async issueWsTicket(actor: ActorContext): Promise<WsTicketResponse> {
    const caller = requireSessionActor(actor);
    const { userId, sessionId } = caller;
    const found = await this.#activeSession(caller);
    const event = { action: 'auth.ws_ticket', targetType: 'session', targetId: sessionId } as const;
    let issued: { ticket: string; expiresAt: Date };
    try {
      issued = await this.#deps.wsTickets.issue({
        userId,
        sessionId,
        displayName: found.owner.displayName,
        color: found.owner.color,
        role: found.owner.role,
        absoluteExpiresAt: found.session.absoluteExpiresAt.toISOString(),
      });
    } catch (error) {
      // A Redis failure is a 503 with Retry-After (audited), never a 500.
      this.#deps.logger.warn({ err: error, sessionId }, 'WebSocket ticket could not be stored');
      this.#audit(caller, {
        ...event,
        outcome: 'failure',
        details: { code: 'SERVICE_UNAVAILABLE', status: 503 },
      });
      throw new ServiceUnavailableError(
        'Realtime tickets are temporarily unavailable.',
        WS_TICKET_RETRY_AFTER_S,
      );
    }
    this.#audit(caller, {
      ...event,
      outcome: 'success',
      details: { expiresAt: issued.expiresAt.toISOString() },
    });
    return { ticket: issued.ticket, expiresAt: issued.expiresAt.toISOString() };
  }

  /** The caller's session and profile as the database sees them now; 401 SESSION_REVOKED once it is not active. */
  async #activeSession(caller: SessionActor): Promise<SessionWithOwner> {
    const found = await findActiveSessionWithUser(this.#deps.db, caller.sessionId, caller.userId);
    if (found === null) throw new UnauthorizedError('SESSION_REVOKED', 'The session is no longer active.');
    return found;
  }

  #audit(actor: ActorContext, event: Omit<AuditEvent, 'requestId' | 'ip' | 'userAgent'>): void {
    this.#deps.audit.record({ ...actorAuditFields(actor), ...event });
  }
}
