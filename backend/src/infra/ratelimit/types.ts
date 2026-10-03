/**
 * Drawing-action limiter contract (SPEC section 3.3, section 10.1): 50 actions per rolling 60 s per user, shared by REST and WS and
 * by all instances. The production implementation is the Redis sliding-window log with an in-process fallback.
 */

export type DrawActionKind = 'area.create' | 'area.update' | 'area.delete' | 'area.restore' | 'draft.start';

export type RateLimitDecision =
  | { allowed: true; limit: number; remaining: number; resetAtMs: number }
  | { allowed: false; limit: number; remaining: 0; retryAfterMs: number; resetAtMs: number };

export interface DrawRateLimiter {
  consume(userId: string, kind: DrawActionKind): Promise<RateLimitDecision>;
}
