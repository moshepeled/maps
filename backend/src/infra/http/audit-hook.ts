/**
 * Generic failure auditing (SPEC section 10.4 "who records what"): on routes that declare `config.auditAction`, any >= 400
 * outcome the service did not record itself - transport 400s, 413, 415, 5xx, revoke 404, ws-ticket 503 - becomes one
 * row `{ action, outcome: 403 ? denied : failure, details: { code, status } }`. 429 (already a coalesced
 * `ratelimit.hit`) and the 401 of `authenticate` (not a user action) are left to their own trails.
 */
import { UuidSchema } from '@snapland/shared';
import type { FastifyInstance, FastifyRequest } from 'fastify';

import type { AuditAction, AuditLogger, AuditTargetType, RequestAuditTracker } from '../audit/types.js';

export interface AuditHookDeps {
  audit: AuditLogger;
  tracker: RequestAuditTracker;
}

/** Whether the hook must write a row for this outcome. */
function needsGenericAuditRow(status: number, authFailed: boolean, alreadyRecorded: boolean): boolean {
  if (status < 400 || status === 429 || alreadyRecorded) return false;
  return !(status === 401 && authFailed);
}

/** The route's `:id` / `:sessionId` path parameter, if it has one - still unvalidated when the request was a 400. */
function pathId(request: FastifyRequest): string | undefined {
  const params = request.params;
  if (typeof params !== 'object' || params === null) return undefined;
  const record = params as Record<string, unknown>;
  const id = record['id'] ?? record['sessionId'];
  return typeof id === 'string' ? id : undefined;
}

/** Only a well-formed UUID names a target: a refused parameter is attacker text (even U+0000, which PostgreSQL rejects). */
function uuidOrNull(id: string | undefined): string | null {
  return id !== undefined && UuidSchema.safeParse(id).success ? id : null;
}

/** The target of an audited route derived from the action's domain and the path parameters. */
function targetOf(
  action: AuditAction,
  request: FastifyRequest,
): { targetType: AuditTargetType | null; targetId: string | null } {
  const [domain] = action.split('.');
  if (domain === 'area') return { targetType: 'area', targetId: uuidOrNull(pathId(request)) };
  if (domain === 'admin') return { targetType: 'system', targetId: null };
  if (action === 'auth.register' || action === 'auth.login') return { targetType: 'user', targetId: null };
  if (domain === 'auth') {
    // Session routes without a path parameter (logout, refresh, ws-ticket) act on the caller's own session.
    const id = pathId(request);
    return {
      targetType: 'session',
      targetId: id === undefined ? (request.auth?.sessionId ?? null) : uuidOrNull(id),
    };
  }
  return { targetType: null, targetId: null };
}

export function registerAuditHook(app: FastifyInstance, deps: AuditHookDeps): void {
  // Every request is counted (not only audited routes): services may audit on any route, and an id shared by
  // overlapping requests must never let one request's mark or release decide another's row.
  app.addHook('onRequest', (request, _reply, done) => {
    deps.tracker.begin(request.id);
    done();
  });
  app.addHook('onResponse', (request, reply, done) => {
    const action = request.routeOptions.config.auditAction;
    try {
      if (action === undefined) return;
      const status = reply.statusCode;
      if (!needsGenericAuditRow(status, request.authFailed, deps.tracker.wasRecorded(request.id))) return;
      const actor = request.actor();
      deps.audit.record({
        action,
        outcome: status === 403 ? 'denied' : 'failure',
        actorId: actor.userId,
        sessionId: actor.sessionId,
        ...targetOf(action, request),
        requestId: actor.requestId,
        ip: actor.ip,
        userAgent: actor.userAgent,
        details: { code: request.problemCode ?? `HTTP_${status}`, status },
      });
    } finally {
      deps.tracker.release(request.id);
      done();
    }
  });
}
