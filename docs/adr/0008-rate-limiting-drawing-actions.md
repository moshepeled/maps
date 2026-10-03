# ADR-0008: Rate limiting "drawing actions" with a Redis sliding-window log

- Status: Accepted
- Date: 2026-09-27

## Context
"Max 50 drawing actions per minute per user" must hold for REST and WebSocket alike, and across all backend instances. The term
"drawing action" is not defined by the assignment. The rule must be precise, testable and fair to legitimate users.

## Decision
- **Definition.** A drawing action is:
  - a committed-mutation request (POST/PATCH/DELETE/restore of an area) that passed authentication and transport validation - 
    whatever its later outcome (a text-sanitation 400, 422, 428, 403, 404 and 409 all cost 1; this bounds validation-CPU abuse); or
  - a WS `draft.start` without `resume` (charged before the draft-registry claim, so a failed claim still costs 1).

  A `resume` is free only when the draft registry record exists, belongs to the same user, and either belongs to the same session
  (a reconnect) or is `disconnected` (the user signed in again after a session expiry) - one paid start still yields at most one live
  draft. A free `draft.touch` keepalive (every 20 s while a draft is open and quiet) prevents idle expiry, so pausing or naming an
  area never costs a second start; after a genuine expiry the client starts a new draft id (1 action). `draft.end`, cancellation
  and idle expiry delete the record, so "end -> resume" is never free, and a non-resume start for an id that already has a record
  fails with `DRAFT_ID_IN_USE` (no hijacking of another user's visible draft id).

  Vertex/cursor streaming (`draft.update`) is not counted. It is bounded separately by a 10 Hz client throttle and a 20 msg/s
  per-connection token bucket, and it is accepted only for the connection's own active draft. Drawing one polygon costs 2 actions
  (start + save).
- **Algorithm.** An exact sliding-window log (not a fixed window, which permits 2x bursts at window edges):
  - a Redis ZSET `snap:rl:draw:<userId>`;
  - one atomic Lua script that uses Redis `TIME` (immune to instance clock skew);
  - window 60,000 ms, limit 50. Rejected attempts are not recorded.
- **Responses.**
  - REST: 429 `RATE_LIMITED` with `Retry-After` and `X-Draw-RateLimit-*` headers.
  - WS: `error { code: RATE_LIMITED, retryAfterMs }`.
  - Every rejection is counted in metrics; the audit row `ratelimit.hit` is coalesced per (user or IP, scope) per 10 s with a
    `count`, so a flooding client cannot overflow the audit queue.
- **Redis failure.** The one limiter class (`RedisDrawRateLimiter`) falls back to a built-in in-process window with the same
  semantics, logged and counted. The effective limit becomes 50 x instances (availability over strictness).
- **Separate limits.** Generic abuse is handled by @fastify/rate-limit (keys under `REDIS_KEY_PREFIX`): API 300/min per user
  (registered on `preHandler` so it runs after authentication), register/login 10/min/IP, refresh 60/min/IP, WebSocket upgrades
  60/min/IP before ticket consumption. Login failures are capped at 5 per 15 minutes per (username, IP) and 50 per username.
- **Harnesses never weaken the product.** Integration tests raise the generic limits through configuration and test the low limits
  in dedicated suites; the E2E stack raises the per-IP auth/refresh limits in its compose override; the k6 load test signs in seeded
  users and keeps every writer under 50 actions/min, except the one burst that tests the 429.

## Consequences
- The limit is exact and shared across instances and transports. It is testable: the 51st action inside 60 s is rejected on REST
  and on WS, and across two app instances.
- There is one Redis round trip per drawing action, which is negligible.
- ZSET memory is O(50) entries per active user, with a TTL of the window.

## Alternatives considered
- **Fixed window counter**: cheaper, but allows 100 actions in about 1 second across a boundary.
- **Token bucket in Redis**: smooths bursts. However, "50 per minute" maps more transparently to a sliding window, and users get a
  precise `retryAfter`.
- **Counting every vertex**: would make normal drawing hit the limit within one polygon.
