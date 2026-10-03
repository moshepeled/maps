# SPEC history (September 2026) — historical record, not maintained: the build plan (§14), the two QA design-review resolution maps (§17, §18) and the T9 integration-gate change log (§19) as they stood in `docs/SPEC.md` v1.3 before the 2026-09-29 simplification; the current design is `docs/SPEC.md`.

## 14. Build plan & file ownership

> **Wave-0 extension points as built (T0, 2026-09-27).** Where this list is more specific than §3.3 / §12.2, it is what the code
> does; wave-1 tasks plug in here without editing T0 files.
> - **Modules:** each `modules/<m>/index.ts` exports its `ModuleFactory` (`modules/types.ts`: `{ name, register(app), start?(), stop?() }`);
>   `app.ts` registers `APP_MODULES` in the fixed order health, meta, auth, areas, realtime, tiles, admin, retention.
> - **Composition root:** `createContainer(config, overrides)`: `overrides` also accepts `logger`, alongside `clock`, `events`,
>   `drawRateLimiter`, `areaCache`, `audit` and `drafts`. The container also exposes `auditTracker: RequestAuditTracker`, which the
>   `onResponse` audit hook reads. `container.audit` is already the tracking wrapper, so services only call `audit.record(...)`.
> - **App:** `buildApp(container, { modules?, testRoutes? })` returns `SnaplandApp { app, modules, start(), stop() }`: `start()` runs
>   after `listen()`, and `stop()` runs in reverse order during shutdown. The decoration `app.lifecycleState.shuttingDown` drives
>   `/health/ready`. `app.ts` already registers:
>   - `@fastify/cookie`, used by T1's refresh cookie;
>   - `@fastify/websocket`, with `maxPayload = WS_MAX_PAYLOAD_BYTES`, `perMessageDeflate = WS_PERMESSAGE_DEFLATE`, only the
>     `snapland.v1` subprotocol selected, and a `preClose` that closes clients with 1001. T3 only declares `{ websocket: true }` on
>     `/ws`. Upgrades pass through Fastify hooks, so `config: { rateLimit: rateLimitRoute('ws_upgrade') }` and origin/ticket checks
>     reject with plain HTTP before the upgrade.
>
>   `/ws`, websocket routes and `/metrics` are exempt from the `REQUEST_TIMEOUT_MS` safety net.
> - **Route helpers:**
>   - `rateLimitRoute(scope)` (`infra/http/rate-limits.ts`) is a marker. The `onRoute` hook expands it into a per-scope Redis bucket
>     `<prefix>rl:<scope>:u:<userId>|ip:<ip>`. `api` and `client_errors` are keyed by user after `authenticate`; the other scopes by IP.
>     Authenticated `/api/v1` routes without a marker get `api`.
>   - `withProblems({ 200: Schema }, 401, 404, …)` and `SECURITY_BEARER` (`infra/http/openapi.ts`) build the response map and security
>     entry. Global errors 400/429/500/503 are always added.
>   - Audited routes set `config: { auditAction }`.
> - **Config:** `AppConfig` keys are the env names of §11.3. User decision D-1 sets the defaults `GOVMAP_TILES_ENABLED=false` (read
>   only in `config/env.ts`, `modules/meta` and `modules/tiles/tiles.config.ts` — the tile module's single config view, which answers
>   503 `GOVMAP_DISABLED` per the §8.3 flag row) and `VITE_ENABLE_ITM_LAYER=true` (read only in `frontend/src/config.ts`, as a kill switch).
> - **Integration harness (§12.2):**
>   - Runs clone a migrated template database `snapland_it_tpl_<migrationsHash12>`, built once under a PostgreSQL advisory lock, into
>     `snapland_it_<runId>`, instead of migrating per run. Databases and `snaptest<runId>:` keys of runs older than 6 h are garbage-collected.
>   - `createTestApp` also takes `modules?` (default: all) and `start?` (default: true). It returns
>     `{ app, container, config, snap, logs, listen(), close() }`; `config` takes env names with typed or string values.
>   - Helpers in `test/helpers/`:
>     - `tcp-proxy`: `pause` / `stall` / `resume` / `close`;
>     - `net`: `uniqueIp`;
>     - `redis-admin`: `killClientByName`, `clientNames`;
>     - `users`: `createUser`, `bearer`;
>     - `ws-client`: `openWs` / `connectWs`, with Origin and subprotocol;
>     - `wait-for`, `fixtures`, `audit` (`createMemoryAudit`), `log-capture`.
> - **Scoped gates (§12.1):** the Vitest 5 CLI form is unchanged. `--coverage.include=<file>` replaces the config include, can be
>   repeated, and the thresholds apply to the reduced set.
> - **Stubs:** `backend/src/scripts/user-admin.ts` exists as a stub with the final `run()` signature; it exits 1 as not implemented, and
>   T1 replaces it. `frontend/src/{App.tsx,config.ts,config.test.ts,vite-env.d.ts}` belong to the skeleton and transfer to T5.

Parallel work is safe only with disjoint write sets. Every path below has exactly one owner per wave. Paths not listed are owned by
the team lead. Rules for every task:
- Do not run `npm install <pkg>` or edit `package-lock.json`. Wave 0 installs every dependency in §4.1; a missing dependency is
  reported to the team lead.
- Do not edit `packages/shared/**`, `backend/src/container.ts`, `backend/src/app.ts` or other tasks' paths. Contract gaps are
  reported, not patched in parallel.
- **Wave 1 (T1–T5) proves its work with the scoped gates of §12.1** (lint, type-check, unit, unit coverage, integration and format
  restricted to the task's owned paths) and reports their output as evidence. A failure located in another task's path is reported,
  never fixed. The repo-wide gates (`npm run verify`, `npm run test:integration`, combined coverage, build) are run by T0 at the end of
  wave 0 and by T9 after wave 1; T6, T7 and T8 (which run after T9) leave them green.
- Every script a task writes follows §3.8 (typed, `run(argv, deps)` + entry guard, parseArgs, structured logging, unit test).
- Make no git commits.

| Task | Wave | Role | Owns (writes) | Depends on |
|---|---|---|---|---|
| T0 Foundation | 0 | team-lead | root configs (`package.json`, lockfile, `.npmrc`, `.nvmrc`, `tsconfig.base.json`, `tsconfig.scripts.json`, `eslint.config.js`, Prettier, `.editorconfig`, `.gitattributes`, `.gitignore`, `.env.example`), `scripts/lib/**`, `scripts/{setup-env,check-banned-deps,check-publishable,clean-copy,typecheck-paths}.mjs` + their `*.test.mjs`, `scripts/vitest.config.mjs`, `scripts/banned-packages.json`, initial `docker-compose.yml` (postgres + redis + redis-cache), `docker/postgres/**`, `packages/shared/**`, `backend/{package.json,tsconfig*.json,vitest.config.ts,vitest.integration.config.ts,vitest.all.config.ts}`, `backend/migrations/**` (0001–0008), `backend/src/{main,app,container}.ts`, `backend/src/config/**`, `backend/src/infra/**` (except the T4 files below; includes `directory/**`, `drafts/**`, `lifecycle.ts`, `audit/{types,in-memory,coalescer,request-audit-tracker}.ts`, `http/audit-hook.ts`, `http/request-context.ts`, `cache/{types,key-plan,in-memory}.ts`), `backend/src/modules/{types.ts,health/**,meta/**}`, stub `index.ts` of every other module and of `infra/{ratelimit,cache,audit}`, `backend/src/scripts/{migrate,export-openapi,smoke}.ts`, `backend/test/{setup,helpers}/**`, `backend/test/integration/foundation/**`, skeletons of `frontend/`, `e2e/`, `loadtest/` (package.json, tsconfig, configs, placeholder entry and, where a coverage include set would be empty, one minimal placeholder module with a test); deletes the stray root `bash.exe.stackdump` | — |
| T1 Auth & sessions | 1 | backend | `backend/src/modules/auth/**`, `backend/src/scripts/user-admin.ts`, `backend/test/integration/auth/**` | T0 |
| T2 Areas | 1 | backend | `backend/src/modules/areas/**`, `backend/test/integration/areas/**` | T0 |
| T3 Realtime gateway | 1 | backend | `backend/src/modules/realtime/**`, `backend/test/integration/realtime/**` | T0 |
| T4 Platform services | 1 | backend | `backend/src/infra/ratelimit/{redis-sliding-window,resilient,index}.ts` + `resilient.test.ts`, `backend/src/infra/cache/{redis-area-cache,l2-codec,index}.ts` + `l2-codec.test.ts`, `backend/src/infra/audit/{buffered-writer,index}.ts` + `buffered-writer.test.ts`, `backend/src/modules/{tiles,admin,retention}/**`, `backend/test/integration/platform/**` (the Redis limiter's Lua and the Redis cache are proven there — no colocated test touches Redis) | T0 |
| T5 Frontend app | 1 | frontend | `frontend/**` | T0 |
| T9 Integration gate | 2 (first) | team-lead | any path needed to fix seams between wave-1 modules (no other task runs concurrently), plus the new `backend/test/integration/system/cross-instance-rest-ws.int.test.ts`; evidence goes into the task report | T1–T5 |
| T6 Containers, seed, load tests, benchmarks | 2 | devops | `backend/Dockerfile`, `.dockerignore`, `docker-compose.yml` (full stack), `docker-compose.e2e.yml`, `docker/{nginx,prometheus,grafana}/**`, `backend/src/scripts/seed.ts`, `loadtest/**`, `docs/BENCHMARKS.md`, `docs/benchmarks/**` | T9 |
| T7 QA: E2E + system tests + traceability audit | 2 | qa | `e2e/**`, `backend/test/integration/system/**` (except T9's file, which it may extend) | T6 |
| T8 Docs: README, OpenAPI & WS schema export | 2 | docs | `README.md`, `docs/openapi.json`, `docs/ws-protocol.schema.json`, `scripts/export-ws-schema.ts`, `scripts/check-readme.mjs` + `scripts/check-readme.test.mjs` | T6 |

Wave 2 runs T9 → T6 → (T7 ∥ T8). T9 exists because wave-1 tasks cannot prove the cross-stack flows (T5 needs T1–T3 running), and
because the repo-wide gates only become meaningful once every wave-1 file exists: the team lead runs the repo-wide gates, runs backend
+ frontend locally and performs the cross-stack smoke with the §12.3 `two-users-realtime` assertions (parity of the live readout, the
remote chip and the saved `areaKm2`; presence transitions; Map ↔ Aerial mid-draw keeps every point; blocking `/ws` shows `limited`
and saving still works), runs the full unit + integration suites with the **production** `infra/{ratelimit,cache,audit}`
implementations, adds the cross-instance REST → WS system test, and fixes seams before containerisation.

Ownership of the wave-0 stubs transfers as follows:
- `modules/auth/index.ts` → T1 (plus the new file `backend/src/scripts/user-admin.ts`; the backend `package.json` script `user-admin`
  is created by T0)
- `modules/areas/index.ts` → T2
- `modules/realtime/index.ts` → T3
- `modules/{tiles,admin,retention}/index.ts` and `infra/{ratelimit,cache,audit}/index.ts` → T4
- frontend skeleton → T5, `loadtest/` skeleton → T6, `e2e/` skeleton → T7

## 17. QA design review (v1.0 → v1.1): finding → resolution map

*Historical record of v1.1. Where §18 (v1.2) changed a resolution — e.g. the resume rule, the L2 body cap, the tile limit, draft idle
expiry — §18 and the body of this document win.*

Every blocker/major/minor finding and traceability gap of the QA design review is resolved below. "Differs" items keep the v1.1 design
with a one-line justification (§17.4). IDs: M = major (in review order), N = minor, G = traceability gap.

### 17.1 Major findings

| ID | Finding | Resolution | Where |
|---|---|---|---|
| M1, M12, M13 | zod request schemas would return 400 where the spec demands 422 (geometry) / 428 (`baseVersion`) | Transport schemas are structural only (`PolygonGeometryIn`, optional `baseVersion`); domain rules → 422 sub-codes / 428 from the service; stage→status table; `schemas.test.ts` proves every fixture passes transport | §0, §3.5, §6.3 (schemas + status table), §9.2 (HTTP column), §9.3, §12.3 |
| M2 | Bbox "all areas" contract contradicted by snapping, silent culling and the 10-page cap | Exact contract (live ∩ intersects `queryBbox` ∩ extent ≥ `minExtentDeg`), `minExtentDeg` + `culledCount` in the response, `culling-notice`, client `limit=2000` (20k per viewport), seed size distribution, region-load browser benchmark, T2 criteria rewritten | §5.5, §6.3, §8.6, §12.5, §13 #9, §16 SG-22 |
| M3 | Draft resume loophole; foreign `draft.update` overwrites ghosts; `DRAFT_NOT_FOUND` unused | Draft registry lifecycle table: claim `SET NX`, resume only same user **and** session, release/markDisconnected by compare-on-connection, update/end only for the connection's active draft (else `DRAFT_NOT_FOUND`, never relayed) | §3.3 `DraftRegistry`, §7.4, §7.6, §10.1, ADR-0008 |
| M4 | Stored XSS through Leaflet HTML sinks | Output-encoding rule, single `safe-dom.ts` wrapper, lint ban on the sinks, `safe-dom.test.ts` + `E2E/xss.spec.ts` | §3.4, §8.6, §10.7.1, §16 SG-23 |
| M5 | "All user actions" scope undefined; analytics untested | Normative three-trail definition (`audit_logs` for all state changes of any outcome + security events + WS lifecycle; request log for reads; WS aggregates), catalog extended (`admin.audit_query`, `area.update` failure, all limiter scopes), analytics views (migration 0008) + `GET /admin/audit-stats` + IT, `audit-trail.int` in the proof column | §1 R13, §5.2, §6.4, §10.4, §13 #19 |
| M6, M21 | Per-IP auth limit blocks the IT/E2E/load harnesses; rate-limit keys outside the prefix; `api` scope keyed by IP | Separate `refresh` scope; `nameSpace` under `REDIS_KEY_PREFIX`; `api` scope `hook: 'preHandler'` keyed by user; IT env sets high limits + dedicated low-limit tests; E2E compose override; load identities via `seed --emit-tokens` | §6 intro, §10.1, §11.1, §11.3, §12.2 |
| M7 | Benchmarks bounded by the product's own limits | Fan-out writer rotates over 4 users; commit ceiling with 1,000 users (≤ 48/min each); rest-write = POST only; 429 counts recorded; "no scenario bounded by a limiter it does not test" rule | §12.5, T6 criteria |
| M8, M24 | No sanctioned way to simulate Redis/DB outages; stopping shared compose services breaks parallel suites; no config overrides or timing knobs | Normative "never stop shared services" rule; `createTcpProxy` pause/resume; bogus `DATABASE_URL`; `CLIENT KILL` by connection name; `createTestApp({ config, overrides })`; `REALTIME_*`, `TILE_BREAKER_*`, `RETENTION_INITIAL_DELAY_MS` knobs | §3.3, §10.9, §11.3, §12.2 |
| M9 | Realtime would need SQL against auth/areas tables | Wave-0 read ports `SessionReader`, `UserDirectory`, `AreaReader`, plus `DraftRegistry`; the ticket carries the profile + `absoluteExpiresAt` | §3.2, §3.3, §7.2, §7.9 |
| M10, M18 | First registrant of `admin` becomes admin | Username bootstrap removed (boot fails if the old variable is present); admins only via the `user-admin` CLI; T1 IT: registering `admin` yields role `user` | §5.2, §6.2, §10.7.5, §10.7.7, §11.3, ADR-0006 |
| M11 | Default-on ITM layer with math-only proof | Default off in production builds (dev/E2E on); ITM tile-URL vectors; T6 live probe; E2E Map → ITM → Map round trip | §8.1, §8.3, §8.4, §12.3, §12.5, ADR-0007 |
| M14 | §7.5 examples could not pass strict parsing; strict vs forward-compatible contradiction | All examples complete and valid (real uuids, full AreaDto, `activeAreaId`); client schemas strict, server schemas loose + unknown-type fallback; criterion reworded | §7.3, §7.5, §12.3 |
| M15 | A late older event resurrects a deleted area | Client tombstones (`version > max(known, tombstone)`), bounded, TTL ≥ 2 × anti-entropy | §7.12 step 5, §12.3 |
| M16 | `restCursor` advanced by bbox pages → permanently stale out-of-view areas | Cursor advances only from feed pages; empty-store init = min(asOf); catch-up when asOf > cursor; in-store items always applied; 410 reload evicts outside the region | §6.3 change feed, §7.12 step 4 |
| M17 | Draft-id hijack and area-id squatting | Claim is `SET NX` (hijack → `DRAFT_ID_IN_USE`); POST with another user's live draft id → 409 `AREA_ID_CONFLICT`; client regenerates the id and retries once | §6.3, §7.6, §7.12 step 10, §16 SG-21 |
| M19 | One poison row blocks the audit queue; a long User-Agent breaks login | Boundary normalization (UA 512 code points, IP validated), details CHECK on JSON text + 4 KiB writer truncation, SQLSTATE-classified retry with bisection | §3.2, §5.2, §10.4, §10.7.1 |
| M20 | Cache bodies can OOM the `noeviction` Redis | Separate `redis-cache` (allkeys-lru) for L2 bodies, generations stay in the critical Redis, 256 KiB L2 body cap, memory gauge + alert | §2.1, §10.2 step 7, §10.6, §10.8, §11.1 |
| M22 | Global prom-client registry breaks two instances per process | Registry per container, no process-global state in `createContainer`/`buildApp`, `two-instances.int` | §3.3, §10.8 |
| M23 | Infra factory signatures and lifecycle unspecified | `InfraDeps`, `Lifecycle`, normative factory signatures, `container.close()` order, unref'd timers | §3.3, §10.12 |
| M25 | T5's manual cross-stack smoke is impossible in wave 1 | New T9 integration gate (team lead, first in wave 2) owns the cross-stack smoke; T5 acceptance is unit/build-level | §14, tasks |

### 17.2 Minor findings

| ID | Finding | Resolution | Where |
|---|---|---|---|
| N1 | Unassigned or inaccurate proofs (R31, R33, R27, R26, R45) | Concrete E2E assertions named per requirement; R45 cites §3.4; one ban list for lint and `check-banned-deps` | §1, §3.4, §12.3 |
| N2, N22 | Nondeterministic instance placement; a swallowed socket takes 55 s to detect | Reload Bob ≤ 5 times until the instance differs; client welcome timeout 5 s; route handler closes the socket | §7.11, §12.2 |
| N3 | Realtime timings not configurable | `REALTIME_*` env knobs with test values | §7.6, §7.7, §7.9, §11.3 |
| N4 | EXPLAIN proof on 5,000 rows | 12,000 region rows + 3,000 elsewhere; GiST asserted at zoom 14/16, zoom-12 time budget | §5.3 |
| N5 | `db-pool` and T0 unit tests vague; OpenAPI errors unchecked | Concrete db-pool assertions; T0 acceptance lists every T0 test; the OpenAPI test checks declared error statuses | §1 R38, §6 intro, tasks |
| N6, N11 | `latestChangeSeq` below the purge watermark → 410 loop | `GREATEST(max, watermark)` single statement used by REST and WS; retention IT case | §3.3 `AreaReader`, §5.5, §5.6 |
| N7, N17a | Limiter before or after geometry validation? | One order: limiter (preHandler) before any domain validation; every request past transport validation costs 1; IT asserts a 422 consumes an action | §6.3, §10.1 |
| N8 | 4401 at absolute expiry untested; disabled users unreachable; lockout DoS | Absolute-expiry timer tested with a 3 s TTL; `user-admin disable` revokes sessions and closes sockets; lockout keyed by (username, IP) + per-username cap; §13 #18 | §6.2, §7.2, §13 |
| N9, N20 | Spoofable X-Forwarded-For; tickets in nginx logs | nginx overwrites XFF with `$remote_addr`; `TRUST_PROXY=1`; `log_format` with `$uri`; T6 grep | §10.7.6, §11.1 |
| N10 | "Clean checkout" unverifiable; musl bindings; stackdump in the repo | `clean-copy.mjs` procedure, Alpine `npm ci` check, `check-publishable.mjs`, DoD 11, T0 deletes the stackdump | §12.1, §12.6 |
| N12 | Low-zoom EXPLAIN criterion unattainable; parallel overhead | Criterion: GiST at zoom ≥ 14, low zoom recorded and explained; `SET LOCAL max_parallel_workers_per_gather = 0` | §5.5, §12.5 |
| N13 | z15 round trip becomes z16; `{row:08x}` is not a Leaflet token | Round-trip rule restoring the pre-switch zoom; `getTileUrl` subclass | §8.3, §8.4 |
| N14 | `Math.round` rounds halves toward +∞ | Sign-symmetric rounding (half away from zero), tests in all quadrants | §8.7 |
| N15 | Palette values unspecified, examples off-palette | Normative lowercase `USER_PALETTE` = tokens.css order; examples fixed; shared test | §6.2, §7.5, §12.3 |
| N16 | Test Redis prefix could exceed the regex | base36 `runId` ≤ 12 chars; prefix length asserted | §12.2 |
| N17b | `AREA_NOT_DELETED` lacks `current`; cursor example lacks `b` | `current` added; example cursor recomputed with `b` | §3.5, §6.3 |
| N18 | Fan-out writer exceeds the draw limit | Writer rotates over 4 users (30/min each) | §12.5 |
| N19 | Lint/format scope for k6, scripts, docs; `vitest run` with no tests | ESLint overrides, `tsconfig.scripts.json`, ignore lists, `--passWithNoTests`, e2e has no `test` script | §3.4, §12.1 |
| N21 | nginx cache bypasses the Sec-Fetch-Site guard; all 403s negative-cached | Guard also in nginx before `proxy_cache`; only an AccessDenied-XML 403 is a missing tile; other 403s trip the breaker | §8.3, §11.1 |
| N23 | A late close ends a resumed draft; a swept presence entry is never re-added; audit flooding by 429s | Compare-on-connection release/markDisconnected; refresh re-HSETs and re-announces; coalesced `ratelimit.hit` | §7.6, §7.7, §10.1, §10.4 |
| N24 | Realtime module boundaries | Read ports (see M9) | §3.3 |
| N25 | Retention batches vs the 5 s statement timeout; leaked advisory lock | `SET LOCAL statement_timeout` 60 s; area batches ≤ 200; `release(err)` on unlock failure | §5.6 |
| N26 | Tile-boundary semantics could leave stale cache entries | `tilesCoveringClosed` used by reader and writer, with proof and test | §8.2, §10.2 |

### 17.3 Traceability gaps

| ID | Gap | Resolution |
|---|---|---|
| G1 | "analyze" undefined | R0 + §8.5 Analysis (per-area metrics, live drawing metrics, viewport summary) with tests |
| G2 | R3 "all areas" | M2 |
| G3 | R13 scope, analytics, proof column | M5, M19 |
| G4 | R8 draft semantics; generic limits untested; harness blocked | M3, M6, M17 |
| G5 | R14/R15 outage technique | M8 |
| G6 | R19 10k proof, size distribution, region zoom, render time | M2, N4, §12.5 region load |
| G7 | R21 output encoding + status mapping | M4, M1 |
| G8 | R25 absolute expiry, disabled users, read port | N8, M9 |
| G9 | R23 client error sink; 5xx logging test | `POST /client-errors` (§6.4), `errors.int` log assertion (§1 R23) |
| G10 | R26 real GovMap proven only manually | E2E asserts proxy tile responses (annotated if unreachable) + T6 recorded probe |
| G11 | R27 no-blank-frame | UX-AC-44 in `layer-switch.spec` |
| G12 | R31 readout assertion unassigned | `two-users-realtime.spec` (Alice and Bob km²) |
| G13 | R33 status transition | `presence-item[data-status]` viewing → drawing → viewing |
| G14 | R34 ITM proof | M11 |
| G15 | R38 db-pool assertions | N5 |
| G16 | R39/S7 limits vs benchmarks | M7 |
| G17 | R40 pinning mechanism | N2 |
| G18 | R45 reference + lists | N1 |
| G19 | S6 documented error responses | OpenAPI test extended (§1 S6, §6 intro) |
| G20 | S1 clean checkout; session UI | N10; session management documented as API-only (§10.7.5, §13 #20) |
| G21 | R13 reads not audited, unjustified | Justified in §10.4 (request-log trail) and §13 #19 |
| G22 | R13 poison-row / flooding tests | `buffered-writer.test` bisection, `audit.int` poison rows, coalesced rate-limit audits |
| G23 | R14/R7 ordering + cursor tests; routeWebSocket semantics | M15, M16, §12.2 E2E harness |
| G24 | R25 hijack / squatting tests | M17 (`drafts.int`, `areas-crud.int`) |
| G25 | R26 labels path and coverage outside Tel Aviv unverified | The labels overlay is optional in the Aerial group (errors fall back to empty tiles); T6's GovMap probe also fetches `labels` z16 Tel Aviv and `ortho` z12 tiles over Eilat (29.56, 34.95) and the Golan (33.0, 35.75) and records the results — failures are documented, not blocking |
| G26 | R33 timing proof unobtainable | N3 |
| G27 | R40/R41 two instances per process | M22 |
| G28 | R8 rate-limited `draft.start`, then countdown | §7.12 step 9, `draftSession.test.ts` |
| G29 | R19/S7 EXPLAIN at low zoom; z14 truncation risk | N12; client limit 2000 × 10 pages + culling (M2) |
| G30 | S3/S1 lint/format scope | N19 |
| G31 | "Verified OK" evidence (pins, tags, migrations, vectors) | No change needed; the v1.1 DDL additions are re-verified by T0 (up → down → up) |

### 17.4 Where v1.1 deliberately differs from a suggested fix (one-line justifications)

- **Reads are not rows in `audit_logs`** (M5 suggested all reads): viewport reads are about 100× the write volume; the request log is
  the read trail and is retained at least as long as the audit table.
- **No `INFO memory` guard switching the cache to BYPASS** (M20): a separate LRU instance removes the failure mode instead of reacting
  to it; the 256 KiB body cap stays as a second line.
- **Commit ceiling measured through HTTP with 1,000 seeded users**, not by calling `areas.service` from a script (M7): it measures the
  real path (auth, validation, limiter, pool) and needs no limiter override.
- **ITM grid not served from `/api/v1/config`** (M11 option c): the layer is dev/E2E-only; its constants are unit-tested and probed live.
- **`draft.end` only from the owning connection** (M3 allowed "same userId"): reconnects are handled by `resume`, which transfers
  ownership, so no second rule is needed.
- **A hijacking `draft.start` returns `DRAFT_ID_IN_USE`** rather than `FORBIDDEN`/`DRAFT_NOT_FOUND` (M17): precise for honest clients,
  and it reveals nothing beyond what `draft.updated` already broadcasts.
- **EXPLAIN assertions at zoom 14 and 16, not 12** (N4): QA's own 50k-row evidence shows a pkey-ordered plan is correct at region zoom.
- **No `BOOTSTRAP_ADMIN_TOKEN`** (M10 alternative): a CLI-only path has no HTTP attack surface at all.

## 18. Second QA design review (v1.1 → v1.2): finding → resolution map

Every major and minor finding and every traceability gap of the second QA review is resolved below. IDs: **MA** = major (in review
order), **MI** = minor (in review order), **GA** = traceability gap (in review order). Deliberate deviations from a suggested fix are
justified in one line each in §18.4. Measurements quoted in this revision were taken on 2026-09-27 in a throwaway
`postgis/postgis:17-3.5-alpine` container with no published port (PostGIS 3.5.7), removed afterwards; the unrelated containers and
host ports 3000, 5433, 8060 and 8787 were not touched.

### 18.1 Major findings

| ID | Finding | Resolution | Where |
|---|---|---|---|
| MA1, MA11 | Click-drawn E2E/T9 readout and remote chip cannot be within 1e-6 of the fixture; `area-shape` test id does not exist | UX-AC-14(b) adopted: fixture accuracy is a unit proof; E2E/T9 assert parity (readout = `geodesicArea(quantize7(points + provisional))` ≤ 1e-9, chip = relayed 6-dp vertices + cursor ≤ 1e-9 and ≤ 5e-4 vs the author, saved `areaKm2` = Naming readout ≤ 1e-9) plus a 1 px / 5e-3 sanity check at z16; hook gains `draft.provisional`, `remoteDrafts[].cursor`, `areasInView[].areaKm2`; `area-shape` replaced by `__snapland.areasInView` | §1 R31, §8.5, §8.6, §12.3, T7, T9 |
| MA2 | Backend coverage gate unenforced by `verify` and unreachable as scoped; Redis-touching unit tests | Two gates: `verify` runs `test:coverage` (backend unit gate over an explicit pure-module set, ≥ 85 % lines); combined unit + integration gate (`test:coverage:all`, ≥ 80 % lines) run by T9 and DoD 2; any Redis/PG test is `*.int.test.ts` (T4's colocated Redis tests removed); coverage criteria added to T0–T5 and T9 | §1 S5, §12.1, §12.2, §12.4, §12.6, §14, tasks |
| MA3 | Unbounded bbox span at zoom ≥ 17 and byte-unbounded pages (91 MB measured) | Span cap 8,192 px at the requested zoom → 400 `INVALID_BBOX` (`bbox-params.ts`); page **position budget** 150,000 computed in SQL before GeoJSON is generated (≈ 3.6 MB at 7 dp, measured); L1 skips entries > 5 MiB; `viewportSync` clamps; ITs for both | §3.5, §5.5, §6.1, §6.3, §8.6, §12.3, T2 |
| MA4, MA8 | Own draft lost after 60 s idle (pause, Naming) → `DRAFT_NOT_FOUND` storm → 4400; new-session resume (F-11) fails | Free `draft.touch` keepalive every 20 s; idle expiry 120 s and only for silent tabs; the owner receives its own `draft.ended expired`; `DRAFT_NOT_FOUND` for recently owned ids is not counted; client re-starts with a **new** id (1 action) keeping its points; resume allowed for the same user when the record is `disconnected` (new session) | §3.3 `DraftRegistry`, §7.4, §7.5, §7.6, §7.8, §7.12 step 11, §11.3, T3, T5 |
| MA5 | Change-feed catch-up drops areas created during a multi-page load | Region registered as **loading** before its first page; catch-up from `min(restCursor, minAsOf)`; drop rule uses fetched ∪ loading regions; `areasStore` tests incl. limited mode | §6.3, §7.12 step 4, §12.3, T5 |
| MA6 | `USER_PALETTE` contradicts tokens.css v1.1 | SPEC adopts tokens.css v1.1 (single source); `constants.test` parses tokens.css; all examples use palette colours (Alice `#c02c52`, Bob `#0e7c24` at the time; D-6 moved them to `#c44f9d` / `#b86e3d`, slot for slot); `protocol.test` checks example colours. (UI.md §2.3 was already on v1.1 — only SPEC was stale.) | §6.2, §7.5, §12.3 |
| MA7 | Lost `sessions` event leaves revoked/disabled sockets open up to 30 days | Gateway re-validates live sessions from the DB every 60 s and on bus reconnect (`SessionReader.getActiveMany`), closing with 4401; `EventBus.publish` resolves a boolean and `markRevoked` throws, so `user-admin` exits 1 on Redis failures; IT for a lost event | §3.3, §6.2, §7.2 step 5, §7.10, §10.6, §10.8, §13 #25, ADR-0006, T1, T3 |
| MA9 | Client pings only when outbound-idle → false 4408 for a user who only sends | Ping when nothing was **received** for 20 s, regardless of outbound traffic; RealtimeClient test for outbound-only traffic | §7.8, §7.11, §12.3, ADR-0004, T5 |
| MA10 | Lost INCR (Redis unreachable at write, or restart of the persistence-less Redis) serves stale cache; client treats `asOf < restCursor` as safe | Random global **epoch** (`SET NX` when missing, reads bypass until set); failed invalidate clears L1 and retries an epoch bump; every instance bumps the epoch and clears L1 on cmd reconnect; client catch-up from `min(restCursor, asOf)`; ITs for outage and simulated restart | §3.3, §10.2 steps 3–6, §7.12 step 4, §13 #28, T4 |
| MA12 | Wave-1 tasks run repo-wide gates while others are mid-edit | Scoped gates (lint, `typecheck-paths.mjs`, unit, scoped coverage, integration, format) per task; repo-wide gates only in T0 and T9 | §3.8, §12.1, §14, tasks |

### 18.2 Minor findings

| ID | Finding | Resolution | Where |
|---|---|---|---|
| MI1 | 413/415/5xx and some auth failures escape the audit trail | Generic `onResponse` hook writes a failure row for any ≥ 400 on audited routes not recorded by the service (request-audit tracker); catalog failure outcomes added; `audit-hook.int` | §3.3, §10.4, T0 |
| MI2 | Analytics views cannot use the BRIN index; unsummarized BRIN | Endpoint uses base-table statements with `occurred_at` bounds (measured 2.5 ms vs 35 ms); views kept for ad-hoc use; BRIN `autosummarize = on`; plan asserted with `enable_seqscan = off` | §5.2, §5.3, §6.4, §10.4, T4 |
| MI3 | Nothing emits `ratelimit.hit {scope:'login'}` | Auth service is a coalescer producer; asserted in `auth-flow.int` | §6.2, §10.1, T1 |
| MI4 | `timeouts.int` unspecified; 408 not problem+json; foundation tests need non-existent routes | Four normative timeout cases; 408 documented as the one exception (`HTTP_REQUEST_TIMEOUT_MS`); `createTestApp({ routes })` for test-only routes; TCP proxy `stall()`; T4 asserts the tiles 429 | §3.5, §10.7.3, §11.3, §12.2, T0, T4 |
| MI5 | CORS preflight and helmet headers untested | `security.int` assertions spelled out | §10.7.2, §10.7.6, T0 |
| MI6 | Which layer raises `INVALID_BBOX`/`INVALID_TILE` | Bounded strings in transport schemas; `bbox-params.ts` and `tile-request.ts` raise them; tests listed | §3.5, §6.3, §6.4, T2, T4 |
| MI7 | "Only 401/400/429 are free" is inaccurate | Free = 401, transport 400, 429; a sanitation 400 costs 1; IT case | §6.3, T2 |
| MI8 | No E2E draws and saves on Aerial | UX-AC-101 mandatory in `layer-switch.spec` | §1 R29, §12.3 |
| MI9 | R33 proof inconsistent; SG-26 open; REST-only users invisible | One assertion (Bob observes Alice) everywhere; SG-26 resolved in §7.7; §13 #24 | §1 R33, §7.7, §12.3, §13, §16 |
| MI10 | "ITM coordinate readout" undefined; production build shows no projection handling | `coord-readout` (WGS84 + ITM, every build) with unit and E2E tests; README explains enabling the ITM layer | §1 R34, §8.1, §8.3, §8.6, §12.3, T5, T8 |
| MI11 | permessage-deflate measurement unowned | `WS_PERMESSAGE_DEFLATE` knob; T6 runs fan-out with it off and on | §7.8, §11.3, §12.5, T6 |
| MI12 | SG-26…31 open | All accepted in §16 (SG-31 as `createdById`) | §16 |
| MI13 | Repo-level scripts outside the clean-script rules | §3.8 rewritten: `.mjs` + `@ts-check`/`checkJs` (zero-dep, pre-`npm ci`), `run(argv, deps)` + entry guard, `parseArgs` strict, JSON-lines logger `scripts/lib/cli.mjs`, one unit test per script (`test:scripts` in `verify`); root devDependencies explicit | §3.1, §3.4, §3.8, §12.1, T0, T8 |
| MI14, MI22 | Idempotent replay compared with the current row → duplicate after another user's edit | Compare with the version-1 snapshot and `created_by`; replay returns the current state (incl. a tombstone) | §5.5, §6.3, T2 |
| MI15 | History of soft-deleted areas unspecified; bbox IT does not seed deleted rows | 200 until purge, 404 after; `areas-bbox.int` seeds deleted rows | §6.1, §6.3, §5.5, T2 |
| MI16 | Node WS clients send no `Origin` | `connectWs` and `ws/fanout.ts` send the first `CORS_ORIGINS` entry | §7.2, §12.2, T0, T6 |
| MI17 | Tile limit 1,200/min too low for normal Aerial use | 6,000/min/IP (sized from tile arithmetic), E2E 20,000; 429 counts recorded | §6, §8.3, §10.1, §11.1, §11.3, §12.5 |
| MI18 | "GitHub repository" deliverable has no hand-off | S1 hand-off check (`clean-copy --list` = `git add -A --dry-run`) and user commit/push commands in T9/T7 reports; DoD 12 | §1 S1, §12.1, §12.6 |
| MI19 | `viewportSync` at low zoom / antimeridian unspecified | `planViewportRequests` algorithm (pad, span clamp, lat clamp, lng normalise, split) + `viewportSync.test` | §8.6, §12.3, T5 |
| MI20 | Resync drops mid-load areas; eviction leaves stale "fetched" regions | See MA5; eviction removes the affected fetched regions | §7.12 step 4, T5 |
| MI21 | MultiPolygon nesting and `1e999` return 400, not 422 | Documented as transport failures with pinned payloads; `NON_FINITE_COORDINATE` is client-side only | §3.5, §6.3, §9.2, T2 |
| MI23 | Realistic pages exceed the 256 KiB L2 cap | L2 stores gzip-compressed bodies (cap 512 KiB compressed); AC with a realistic 2,000-item page | §10.2, §11.3, T4 |
| MI24 | Per-IP limit tests inherit hits; `CLIENT KILL` can hit other runs | Unique `remoteAddress` per test; `instanceId` = `<runId>-<n>`; kill helper restricted to this run | §3.3, §12.2 |
| MI25 | `actor_id ON DELETE SET NULL` can never fire | Clause dropped (users are never deleted); ERD fixed | §5.2 |
| MI26 | Retention batches aborted by the pool's client `query_timeout` | `withTransaction({ timeoutMs })` sets both timeouts per transaction; `db-pool.int` case | §3.3, §5.6, §5.7, T0, T4 |
| MI27 | `draft.updated` after `draft.ended`; `draft.ended` before `area.changed` | Coalescer and keyframe cancelled before `draft.ended`; receivers ignore ended ids for 30 s; bus event published before the 201; committed ghost kept ≤ 2 s | §2.2, §6.3, §7.6, T2, T3, T5 |
| MI28 | `ws.reject` and lock/draft denials can flood the audit queue | Per-IP `ws_upgrade` limit before ticket consumption; generic `AuditCoalescer` for all high-frequency denials | §3.3, §6, §7.2, §10.1, §10.4 |
| MI29 | Demoted admin keeps access ≤ 15 min; unlimited soft locks | `requireRole` reads the current role from the DB; ≤ 3 locks per connection (`LOCK_LIMIT_REACHED`) | §3.3, §3.5, §7.4, §7.9, §10.7.5 |
| MI30 | Global change feed scalability | Ceiling documented with numbers (§13 #26); see §18.4 | §6.3, §13 |
| MI31 | `RedisKeys` not enumerated; foundation tests need test-only routes; T3's REST→WS AC depends on T2 | `RedisKeys` interface enumerated; `createTestApp({ routes })`; T3 proves cross-instance via a bus event, the REST path moves to T9's `cross-instance-rest-ws.int` | §3.3, §12.2, §14, T3, T9 |
| MI32 | Doc drift nits | SG-26…31 resolved; `lock.snapshot` in the critical lane; `serverTime` is epoch ms in `welcome` and `pong`; cursor `b` recomputed from exact doubles (`DqO-SUBranFCJTKv`); T1 compares 401 bodies with a pinned `X-Request-Id`; DoD 1 matches `verify`; `process.env` ban scope defined; `ws-schema:export` uses `--conditions=@snapland/source`; `LOG_PRETTY` forced off in production and set false in compose | §3.4, §3.6, §6.3, §7.5, §7.8, §12.1, §12.6, §16 |

### 18.3 Traceability gaps

| ID | Gap | Resolution |
|---|---|---|
| GA1 | S1 GitHub repository | MI18 |
| GA2, GA17 | R31 E2E/T9 proof unachievable | MA1 |
| GA3, GA25 | S5 coverage gate | MA2 |
| GA4 | R24 timeouts proof | MI4 |
| GA5 | R29 Aerial E2E | MI8 |
| GA6 | R34 ITM readout | MI10 |
| GA7 | R13 413/415/5xx, revoke 404, ws-ticket 503, login hits | MI1, MI3 |
| GA8 | R13 analytics BRIN claim | MI2 |
| GA9 | R19/R21 span and bytes | MA3 |
| GA10, GA22 | R3/R14 catch-up and region-load race, eviction bookkeeping | MA5, MI20 |
| GA11, GA20 | R30/R7 own-draft expiry, Naming, new-session resume, late `draft.updated` | MA4, MA8, MI27 |
| GA12 | R22/R21 CORS preflight and helmet | MI5 |
| GA13 | R36 permessage-deflate owner | MI11 |
| GA14 | R33 SG-26, REST-only presence | MI9 |
| GA15, GA24 | UX SG-26…31 | MI12 |
| GA16 | Scripts best practices | MI13 |
| GA18 | R25 lost revocation event | MA7 |
| GA19 | R10 freshness after outage/restart; L2 on realistic pages | MA10, MI23 |
| GA21 | R14 outbound-only heartbeat | MA9 |
| GA23 | UX-AC [M] criteria unowned | §12.7 ownership table (every [M] UX-AC has one owner and one named test; T5 component tests, T7 E2E specs with ids in titles) |
| GA26 | DoD 1 coverage claim | MA2 |
| GA27 | R40 cross-instance REST → WS in wave 1 | MI31 (T9 `system/cross-instance-rest-ws.int`) |

### 18.4 Where v1.2 deliberately differs from a suggested fix (one-line justifications)

- **Own-draft recovery uses a new draft id** (QA suggested re-starting with the same id): receivers can then ignore every late update
  for an ended id without ambiguity, and the committed area still replaces the ghost because the save uses the new id.
- **Keepalive is a new free `draft.touch`**, not a `draft.update` with `rev + 1`: a rev bump every 20 s would keep resetting the
  receivers' "paused" ghost state (UX C-07).
- **Change feed keeps no bbox/ids filter in v1.2** (MI30): the ceiling needs > 100 users saving continuously; a bbox filter would also
  need server-side "moved out" events to stay correct, so the ceiling is documented (§13 #26) and region sharding is the upgrade.
- **Both coverage options adopted** instead of one (MA2): a unit gate that `verify` can enforce without Docker, and a combined gate that
  measures the I/O code where it is actually exercised.
- **Role changes are enforced by reading the role on each admin request** instead of revoking the user's sessions (MI29): immediate in
  both directions without logging anyone out.
- **Locks are capped per connection, not per user** (MI29): the check stays a local set lookup before one Lua call; the per-user bound
  (3 × connections) is recorded in §13 #27.
- **The page bound is a stored-position budget computed in SQL**, not a byte budget on serialized output (MA3): it stops the database
  from generating GeoJSON beyond the budget instead of trimming it afterwards; measured ≈ 3.6 MB per page at 7 dp.
- **Repo-level bootstrap scripts stay `.mjs` with `@ts-check`**, not TypeScript via `tsx` (MI13): `setup-env`, `check-publishable` and
  `clean-copy` must run before `npm ci`; `checkJs` in strict mode gives the same type safety.
- **No server-sent keepalive** (MA9, optional): the client's inbound-idle ping already guarantees inbound traffic every ≤ 20 s.
- **Not every UX-AC is an E2E test** (GA23): UI-local criteria (form attributes, formatting, reducer rules) are component/unit tests in
  T5, where they are faster and deterministic.
- **UI.md was not changed** (MA6 said its §2.3 still had the old palette): it had already been updated to the v1.1 palette; only SPEC
  was stale.

---

## 19. Integration gate change log (T9, 2026-09-28)

T9 wired nothing new into `app.ts`/`container.ts` (every module and the production `infra/{ratelimit,cache,audit}` factories
were already registered by T0 and filled in by wave 1), ran the repo-wide gates with that production infrastructure, added
`IT/system/cross-instance-rest-ws.int.test.ts`, drove a two-user cross-stack smoke against two backend instances, and fixed the
seams below. Every change is additive or a clarification; no REST/WS payload changed shape.

### 19.1 Contract clarifications recorded from wave 1 (already implemented; SPEC text updated in place)

| # | Change | Where |
|---|---|---|
| C1 | OpenAPI declares a second security scheme `refreshCookie` (`apiKey`, in `cookie`, name `snap_rt`); `POST /api/v1/auth/refresh` declares `security: [{ refreshCookie: [] }]` (it previously documented the cookie only in its description). | `backend/src/app.ts`, `infra/http/openapi.ts` (`SECURITY_REFRESH_COOKIE`), `modules/auth/auth.routes.ts` |
| C2 | Login failure counters are **reserved atomically before** the password check (one Lua script: check both limits, INCR, `EXPIRE 900 NX`; non-guesses are given back), and keyed by `canonicalUsername` (ASCII registration pattern only, so no Unicode case folding reaches one account through several counter pairs). Limits, keys, window and clear-on-success unchanged. | §6.2, §10.1 |
| C3 | Bbox page budget: the outer filter is `p.cum_positions - p.vertex_count <= $10` (with `<` the sentinel row vanished when the rows before it summed to exactly the budget, ending the page with `hasMore = false` while rows remained). | §5.5 |
| C4 | `areas.bboxTxSettings` is `SELECT set_config('max_parallel_workers_per_gather', '0', true)` — the `SET LOCAL` equivalent that can be a named prepared statement. | §5.5 |
| C5 | §6.3 details where the text was silent: (a) an idempotent create replay (200) carries `serverChangedFields` = the mergeable fields changed since version 1; (b) `GET …/versions?includeGeometry=true` **lowers** the limit to 20 instead of answering 400; (c) `VERSION_CONFLICT` on DELETE/restore sets `conflictingFields` to the raw `changed_fields` since the base (may include `deleted`) and `serverChangedFields` to its mergeable subset; (d) `AREA_DELETED` also carries top-level `deletedAt` and `deletedBy` next to `current`. | §6.3 (this table is normative) |
| C6 | Admin routes mount `requireRole('admin')` at `preValidation`: a non-admin always gets 403 (audited as denied), never a 400 that reveals validation rules. | §3.3 |
| C7 | `retention_last_run` gains `status` (`completed \| failed \| stopped`) and `reason`; it is written while the advisory lock is held, and failed/stopped runs that held the lock record their partial `purged`. | §5.6 |
| C8 | Tile proxy: bounded slot wait `min(TILE_UPSTREAM_TIMEOUT_MS, max(250, REQUEST_TIMEOUT_MS − TILE_UPSTREAM_TIMEOUT_MS − 500))` (3,500 ms by default) → 503 `SERVICE_UNAVAILABLE` + `Retry-After: 1`; breaker consulted once a slot is held; outcomes of permits from before the last opening (older `generation`) are ignored. | §8.3 |
| C9 | SQL outside repositories is allowed only in `infra/db/**`, `infra/directory/queries.ts` and `infra/audit/buffered-writer.ts` (the §10.4 `unnest` batch insert). | §3.2 |
| C10 | `GOVMAP_TILES_ENABLED` is also read by `modules/tiles/tiles.config.ts` (the module's single config view, 503 `GOVMAP_DISABLED`). | §14 note |
| C11 | Test harness: `InMemoryEventBus` records the channel of each envelope (`publishedWithChannel`, `publishedOn(channel)`); `waitFor` measures time with `performance.now()` (a host wall-clock jump had failed a realtime test). | `infra/events/in-memory.ts`, `test/helpers/wait-for.ts` |
| C12 | §12.1 S1 hand-off command: the `sed` replacement is `\1` and both lists are sorted (the table had a broken expression). | §12.1 |

### 19.2 Seam fixes found by the gate

| # | Defect (how it surfaced) | Fix | Files |
|---|---|---|---|
| F1 | **Concurrent edits by different users answered 404 instead of 409.** `areas.lockById` was one `SELECT … JOIN users … FOR UPDATE OF a`; under READ COMMITTED a writer queued behind another user's commit re-checked the new row version (EvalPlanQual) against the users rows read before the wait, the `updated_by` join failed and the row "disappeared" → `AREA_NOT_FOUND`. Seen as 9 × 404 in the repo-wide `areas-concurrency` run (it passed alone only when Alice won the race). | Lock the `areas` row alone (`SELECT id … FOR UPDATE`), then read it with its joins in a second statement (fresh snapshot = the committed version). Deterministic regression test: a held row lock, Bob queued first, Carol second → Bob 200, Carol 409 with `current.updatedBy = Bob`. | `backend/src/modules/areas/areas.repository.ts`, `backend/test/integration/areas/areas-concurrency.int.test.ts` |
| F2 | `global-rate-limits.int` "WebSocket upgrade flood" failed in the repo-wide run: its real loopback upgrades shared the per-IP `ws_upgrade` bucket (limit 2) with every earlier WS suite of the run (§12.2 isolation rule 1). | The test owns a fresh client address through `X-Forwarded-For` (trusted loopback hop). | `backend/test/integration/foundation/global-rate-limits.int.test.ts` |
| F3 | The `user-admin` unit test ran the real CLI context: a unit test connected to the dev PostgreSQL/Redis and could write to it (§12.2). | Injected `openContext` that rejects; describe renamed (the CLI is no longer a stub). | `backend/src/scripts/scripts.test.ts` |
| F4 | No proof of REST on instance A → WS on instance B with production infra. | New system test (create, update, delete fan-out ≤ 500 ms, measured 14–67 ms; no delivery outside the viewport; B's cached bbox page is never served without A's write). | `backend/test/integration/system/cross-instance-rest-ws.int.test.ts` |

### 19.3 Notes for T6/T7/T8

- **E2E view for `two-users-realtime`** (§12.3): centred on the fixture centre (32.0845, 34.7853) at z16 in 1280×720, the fixture's
  top corners (lat 32.089) fall under the drawing HUD (y ≈ 70–155 px) and the third click lands on the HUD. Centre the view at
  **lat 32.0850** (the T9 smoke did: all four corners placed at 0 px distance) or use a taller viewport.
- **Playwright `page.unrouteAll()` does not remove `routeWebSocket` handlers**: the degradation spec's "unroute" step must use a
  handler flag (close while blocked, `ws.connectToServer()` afterwards).
- **Cache assertions** must warm until `X-Cache: HIT-L1`: the first bbox read on a fresh key prefix bypasses (no epoch yet, §10.2 step 3).
- The remote draft chip is anchored at the author's latest point (UX C-07), not at the cursor; with the desktop areas panel open it
  can sit under the panel.
- Wave-1 requests for the container images (tokens.css in the nginx build context, CSP `img-src` for GovMap/OSM/Esri tiles,
  `VITE_E2E_HOOKS=true` at build time for the E2E build) belong to T6.

### 19.4 Considered and deliberately not changed

- **Collation-independent username index** (T1 optional): recorded as §13 #30; it needs a new migration and matters only for a
  Turkish-locale database.
- **`createTestApp` hook building overrides from the container's metrics** (T2 optional): only affects which registry an injected
  in-memory cache reports to in tests; production wiring is unaffected.
- **Windows path filter for `test:integration`** (orchestrator note): `npm run test:integration -w @snapland/backend -- test/integration/platform`
  selects the platform files under Git Bash, `cmd.exe` and PowerShell (`npm.cmd`; `npm.ps1` is blocked by this host's execution
  policy), so no configuration change was needed.
