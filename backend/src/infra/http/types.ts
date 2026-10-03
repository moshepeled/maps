/**
 * Fastify type augmentation for the app decorations (SPEC section 3.3): `app.authenticate`, `app.requireRole`,
 * `app.drawRateLimit`, `request.auth`, `request.actor()`, `request.logContext` and the `auditAction` route config.
 */
import type { onRequestHookHandler, preHandlerHookHandler } from 'fastify';
import type { FastifyInstance, RawServerDefault, FastifyBaseLogger } from 'fastify';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';

import type { AccessClaims } from '../auth/access-tokens.js';
import type { AuditAction } from '../audit/types.js';
import type { DrawActionKind } from '../ratelimit/types.js';
import type { ActorContext } from './request-context.js';

/** The application instance type (FastifyInstance with the zod type provider). */
export type AppInstance = FastifyInstance<
  RawServerDefault,
  IncomingMessage,
  ServerResponse,
  FastifyBaseLogger,
  ZodTypeProvider
>;

export interface LifecycleState {
  /** true once graceful shutdown started: `/health/ready` answers 503 (section 10.12 step 1). */
  shuttingDown: boolean;
}

declare module 'fastify' {
  interface FastifyInstance {
    /** onRequest hook: verifies the Bearer token, checks revocation, sets `request.auth` (401 otherwise). */
    authenticate: onRequestHookHandler;
    /** preHandler: the caller's CURRENT role and disabled flag are read from the DB (403 FORBIDDEN otherwise). */
    requireRole(role: 'admin'): preHandlerHookHandler;
    /** preHandler: consumes one drawing action, sets X-Draw-RateLimit-*, 429 RATE_LIMITED when exhausted. */
    drawRateLimit(kind: DrawActionKind): preHandlerHookHandler;
    lifecycleState: LifecycleState;
  }

  interface FastifyRequest {
    /** Set by `app.authenticate`; null on public routes. */
    auth: AccessClaims | null;
    /** Normalised actor of the request (sanitised user agent, validated IP). */
    actor(): ActorContext;
    /** Extra fields for the request completion log line (e.g. bbox reads add zoom, items, cache outcome). */
    logContext: Record<string, unknown>;
    /** The problem code sent for this request (set by the error handler; read by the audit hook). */
    problemCode: string | null;
    /** True when `app.authenticate` rejected the request (its 401 is not a user action, section 10.4). */
    authFailed: boolean;
  }

  interface FastifyContextConfig {
    /** Audited routes declare their action; the onResponse audit hook records unrecorded >= 400 outcomes. */
    auditAction?: AuditAction;
  }
}
