/** Small helpers shared by the auth services: the authenticated actor and the actor fields of audit events. */
import type { AuditEvent } from '../../infra/audit/types.js';
import { UnauthorizedError } from '../../infra/http/errors.js';
import type { ActorContext } from '../../infra/http/request-context.js';

export interface SessionActor extends ActorContext {
  userId: string;
  sessionId: string;
}

/**
 * The actor of a route behind `app.authenticate`. The hook guarantees both ids; the check keeps a route that forgot
 * the hook from ever acting on a null session.
 */
export function requireSessionActor(actor: ActorContext): SessionActor {
  const { userId, sessionId } = actor;
  if (userId === null || sessionId === null) {
    throw new UnauthorizedError('UNAUTHENTICATED', 'A Bearer access token is required.');
  }
  return { ...actor, userId, sessionId };
}

/** The who-and-where of an audit event: the request's authenticated user (null on public routes) and its metadata. */
export function actorAuditFields(
  actor: ActorContext,
): Pick<AuditEvent, 'actorId' | 'sessionId' | 'requestId' | 'ip' | 'userAgent'> {
  return {
    actorId: actor.userId,
    sessionId: actor.sessionId,
    requestId: actor.requestId,
    ip: actor.ip,
    userAgent: actor.userAgent,
  };
}
