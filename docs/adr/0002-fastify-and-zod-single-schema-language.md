# ADR-0002: Fastify 5 with Zod 4 as the single schema language

- Status: Accepted
- Date: 2026-09-27

## Context
Every external input must be validated at the boundary: HTTP bodies, params and queries; WS messages; env vars; decoded cursors; and
Redis bus messages. The API must also publish OpenAPI documentation. Keeping separate validation code, TypeScript types and docs in
sync is a classic source of drift.

## Decision
- **Fastify 5.12** is the HTTP/WS server. It is fast, has encapsulated plugins, and its lifecycle hooks carry auth, rate limits and
  timeouts. It has first-class pino logging and graceful `close()`.
- **Zod 4.6** schemas live in `@snapland/shared`. They are used:
  - on the server through `fastify-type-provider-zod` 7 (validation plus response serialization);
  - to generate OpenAPI 3.1 via `@fastify/swagger`;
  - in the browser to parse API responses and WS messages;
  - for env validation (`backend/src/config/env.ts`, fail-fast).
- The one hot path that skips per-request response validation is the bbox list. Its body is produced by the repository mapper,
  cached as a string and sent as-is. The schema still documents it.
- **Transport vs domain validation.** Request schemas validated by Fastify are *transport* schemas: JSON shape, types and
  abuse caps only, and every failure is 400 `VALIDATION_FAILED`. Domain rules - polygon validity (type literal, ring and vertex
  counts, closure, topology, area), required preconditions (`baseVersion` -> 428), permissions - run after that in services and the
  shared `validatePolygon()`, and return their own codes (422 with sub-codes, 428, 403, 409). Putting a domain rule into a
  transport schema would silently turn a documented 422/428 into a 400, so SPEC section 6.3/section 9.2 pin the status of every stage.
- **Direction-specific strictness for WS.** Client -> server schemas are strict (unknown keys and types rejected); server -> client
  schemas are loose (unknown fields tolerated, unknown types surfaced as `{ kind: 'unknown' }`), so the server can evolve without
  breaking older clients.

## Consequences
- One definition per contract yields runtime validation, static types (`z.infer`) and documentation.
- Zod validation is slower than Ajv-compiled TypeBox. It is acceptable at our request rates, and the heaviest response bypasses it.
  If validation throughput ever becomes the bottleneck, TypeBox 1.x plus `@fastify/type-provider-typebox` is the documented escape
  hatch.
- `fastify-type-provider-zod` 7 requires zod >= 4.1.5 and @fastify/swagger >= 9.5.1, both satisfied by the pins.

## Alternatives considered
- **Express + express-validator**: weaker typing, no schema-driven OpenAPI, manual async error handling.
- **NestJS**: heavy decorators/DI for a small service; hides the layering we want to show explicitly.
- **TypeBox everywhere**: less ergonomic in the browser, and it was recently renamed (`@sinclair/typebox` -> `typebox`), so
  ecosystem examples are stale.
