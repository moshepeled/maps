# ADR-0001: npm-workspaces monorepo with a shared TypeScript contracts package

- Status: Accepted
- Date: 2026-09-27
- Deciders: team-lead

## Context
Snapland has three deliverables that must agree on the same contracts: the REST DTOs, the WebSocket protocol, the polygon validation
rules and the geodesic area algorithm. The client shows a live area preview and validation feedback that must match what the
server will accept and store. If the two sides drift, users see numbers or errors that differ from the server's.

## Decision
- One repository with npm workspaces: `packages/shared` (`@snapland/shared`), `backend`, `frontend` and `e2e` (the k6 load
  test in `loadtest/` is a plain script, not a workspace).
- `@snapland/shared` is the single source of truth for:
  - zod schemas (REST + WS);
  - error codes;
  - limits;
  - polygon normalization/validation;
  - geodesic area (geographiclib);
  - Web Mercator/tile math;
  - text sanitization.
- The package has no I/O and no Node- or DOM-only APIs.
- "Live types": the package's `exports` includes a custom `@snapland/source` condition that points at `src/index.ts`.
  - Type-checking, ESLint and `tsx` use that condition.
  - Vite/Vitest alias the package to its source.
  - Production builds resolve to the compiled `dist`.
  - Result: no stale builds during development or tests.
- Exact version pins (`save-exact=true`) and a committed lockfile, with one `npm ci` for the whole repo.

## Consequences
- Contract changes are one edit, type-checked across backend and frontend in the same `npm run typecheck`.
- Client preview and server validation run the same code, so they agree by construction; tests prove this against the PostGIS
  fixtures.
- The shared package must stay small and dependency-light because it ships to the browser: only zod and geographiclib-geodesic.

## Alternatives considered
- **Separate repos / published packages**: versioning overhead with no benefit for one team.
- **OpenAPI codegen for the client**: covers REST only, not the WS protocol, validation or geodesy.
- **Turborepo/Nx**: unnecessary at this size; npm workspaces are sufficient and have no extra tooling.
