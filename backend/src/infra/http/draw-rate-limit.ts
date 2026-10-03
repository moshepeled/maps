/**
 * `app.drawRateLimit(kind)` (SPEC section 3.3, section 6.3 step 3, section 10.1): a preHandler that consumes one drawing action after
 * authentication and transport validation, before any domain work - so every request that reaches it costs one action
 * whatever its later outcome. Sets `X-Draw-RateLimit-*`; a rejection is a 429 RATE_LIMITED, counted and audited through
 * the coalescer (one row per user per 10 s window, so a flood cannot overflow the audit queue).
 */
import type { preHandlerAsyncHookHandler } from 'fastify';

import type { AuditCoalescer } from '../audit/types.js';
import type { Clock } from '../clock.js';
import type { Metrics } from '../metrics/metrics.js';
import type { DrawActionKind, DrawRateLimiter } from '../ratelimit/types.js';
import { RateLimitedError, UnauthorizedError } from './errors.js';

export interface DrawRateLimitDeps {
  limiter: DrawRateLimiter;
  metrics: Metrics;
  auditCoalescer: AuditCoalescer;
  clock: Clock;
  /** DRAW_RATE_LIMIT_WINDOW_MS (for the message only; the limiter owns the window). */
  windowMs: number;
}

export function createDrawRateLimit(
  deps: DrawRateLimitDeps,
): (kind: DrawActionKind) => preHandlerAsyncHookHandler {
  return (kind) =>
    async function drawRateLimit(request, reply) {
      if (request.auth === null) throw new UnauthorizedError('UNAUTHENTICATED', 'Authentication required.');
      const userId = request.auth.userId;
      const decision = await deps.limiter.consume(userId, kind);
      const resetInS = Math.max(0, Math.ceil((decision.resetAtMs - deps.clock.now()) / 1000));
      reply.header('X-Draw-RateLimit-Limit', String(decision.limit));
      reply.header('X-Draw-RateLimit-Remaining', String(decision.remaining));
      reply.header('X-Draw-RateLimit-Reset', String(resetInS));
      if (decision.allowed) return;

      deps.metrics.rateLimitRejectionsTotal.inc({ scope: 'draw', transport: 'rest' });
      const actor = request.actor();
      deps.auditCoalescer.record(`ratelimit:draw:${userId}`, {
        action: 'ratelimit.hit',
        outcome: 'denied',
        actorId: userId,
        sessionId: actor.sessionId,
        targetType: 'user',
        targetId: userId,
        requestId: actor.requestId,
        ip: actor.ip,
        userAgent: actor.userAgent,
        details: { scope: 'draw', kind, transport: 'rest', limit: decision.limit },
      });
      throw new RateLimitedError({
        scope: 'draw',
        limit: decision.limit,
        retryAfterMs: decision.retryAfterMs,
        detail: `Drawing action limit reached (${decision.limit} per ${Math.round(deps.windowMs / 1000)} s).`,
      });
    };
}
