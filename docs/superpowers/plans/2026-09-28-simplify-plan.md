# Simplification plan (2026-09-28)

| | |
|---|---|
| Owner | team-lead |
| Trigger | Product-owner rule (2026-09-28): "as simple as possible, with best practices", applied to the whole codebase |
| Input | Read-only audits of every non-frontend area: areas, auth/admin, realtime, tiles/retention/health/meta, infra, backend core, shared, tooling, docs (110 proposals) |
| Out of scope | `frontend/**`. The Studio redesign workflow owns it right now. |
| Hard constraints | Every bullet of [`instractions.md`](../../../instractions.md) stays implemented and tested. The user decisions D-1, D-2 and D-4...D-6 stay. No REST, WebSocket or DB contract change unless listed below. No edit may force a frontend change. |

## 1. Outcome at a glance

- **99 proposals accepted.** 11 whole proposals are rejected or deferred, and 7 more are accepted only in part (section 4).
- **11 work packages:** 7 in wave 1 (parallel, disjoint files) and 4 in wave 2 (they depend on wave 1).
- **Expected reduction:** roughly 5,000 lines of backend, shared, test, script and config code. `docs/SPEC.md` shrinks from 4,393 to at most 1,500 lines. The build and review history moves to `docs/archive/`, and the README gains the six graded sections it is missing.
- **Gaps closed:** two graded submission items have no deliverable today: *Performance benchmarking results* and *Load testing considerations*. The README also documents a `seed` command whose source file does not exist. W2-BENCH closes all three with a minimal seed script, one k6 script and measured results.

## 2. Ground rules for every package

1. **Ownership is exclusive.** Edit only your `owned_paths`. If you need a change elsewhere, write it in your report as a follow-up. Wave-1 packages share one working tree and run at the same time.
2. **Keep shared entry points compiling at every save.** Every integration run of every package loads `backend/src/app.ts`, `backend/src/container.ts`, `backend/src/config/env.ts`, `backend/test/setup/**` and `backend/test/helpers/**`. Make each save of those files a complete, compiling change. If an integration run fails inside a file you do not own, re-run it once before you report.
3. **Docs are edited only by W2-DOCS.** That covers `docs/SPEC.md`, `README.md` and the ADRs. Every other package ends its report with a *Doc follow-ups* list that W2-DOCS applies.
4. **Contracts are frozen.** REST paths, bodies and statuses, WS messages and close codes, DB schema, the `/api/v1/config` body, metric names and labels, and the Redis value formats all stay the same. Only these contract changes are allowed:
   - the admin audit-row details (A9);
   - three unused env vars are removed (core:P5);
   - `RetentionRunResult` reports `'stopped'`, which is internal (tiles:P4);
   - the pre-welcome WS flood rule changes (RT-7);
   - `GET /metrics` at the nginx edge now returns the SPA shell instead of 404 (T13).
5. **Never delete a test that proves a graded bullet** unless the step names the test that replaces the proof.
6. **Never destroy the user's stack.** Do not run `docker compose down -v` on the default `snapland` project. Stack checks use a throwaway project (`-p snapland-verify` / `-p snapland-bench`) on alternate host ports and are torn down with `down -v` on that project only.
7. **Integration precondition:** the compose `postgres`, `redis` and `redis-cache` services are up (`docker compose up -d postgres redis redis-cache`). Each run gets its own database and Redis key prefix, so parallel runs do not interfere.
8. **No git commits.** The repository has no commits yet. The user commits.
9. **Proposal ids.** Two audits both used `P1…`, so their ids are prefixed here: `core:P1…P12` (backend core) and `tiles:P1…P10` (tiles/retention/health/meta). Other ids are as the reviewers gave them (AR-, A, RT-, INFRA-, S, T, docs-).

## 3. How overlapping proposals were merged

| Topic | Proposals | Resolution |
|---|---|---|
| Startup abort teardown | INFRA-1, core:P3 | One change, in W1-CORE |
| Forwarding infra factories and `InfraDeps` | INFRA-4, core:P4(a)(c), part of INFRA-2 | W1-INFRA; `audit.int.test.ts:226-243` is deleted, not rewritten |
| Synchronous `createContainer` | core:P4(b) | W2-SEAMS, because its call sites belong to several wave-1 packages |
| Recording cache in the areas kit | AR-5(1), INFRA-11 | INFRA-11 wins: delete `InMemoryAreaQueryCache` and spy on the production cache |
| WebSocket test clients | RT-4, core:P8 | One change, in W1-REALTIME: delete the dead `connectWs`; one `untilOpen`; listener attached before `open` |
| `AREAS_SQL` visibility | AR-7(2), core:P1 | `AREAS_SQL` stays exported, because the EXPLAIN test imports it |
| `USER_ADMIN_COMMANDS` aliases | A10, core:P11 | W1-CORE |
| `withTimeout` helper | INFRA-7, tiles:P9 (optional part) | W1-INFRA owns both health and the helper |
| `pgErrorCode` | INFRA-8, tiles:P4 | Stays exported from `infra/db/execute.ts` under the same name; the retention service imports it there |
| Seed references | core:P2, T9, T6 | Fixed by implementing a minimal `seed.ts` (W2-BENCH), not by deleting the references |
| `ws-schema:export` script | T5, docs-08 | W1-TOOLING removes the script; W2-DOCS removes the doc mentions |
| Config rename layers | RT-3, tiles:P6(a), tiles:P8 | All accepted, with one style: components take `Pick<AppConfig, …>` |
| SPEC updates requested by code audits | many | Collected in the W2-DOCS instructions |
| Test fixture SQL duplicated across kits | core:P10(e) | W2-SEAMS, after the wave-1 kit edits |

## 4. Rejected or deferred

| Id | Decision | Reason |
|---|---|---|
| AR-8 | Rejected | Stage-13 GEOS pre-check. When a shape passes the shared validator but GEOS rejects it, this is the only path that returns `ST_IsValidReason` with a location. The DB CHECK fallback returns only a constraint name. Removing it would weaken the graded *prevent invalid shapes* bullet and the error quality, for a modest gain of ~70 lines and one query. |
| AR-9 | Rejected | Generated measurement columns. They need a new migration that rewrites `areas` and re-creates its CHECK, and depend on PostGIS geography functions being IMMUTABLE. This is a DB contract change for ~45 lines, and the formulas already live in one repository file. |
| tiles:P1 | Deferred: needs a product-owner decision | Deleting the GovMap 2025 proxy reverses user decision **D-1 item 3** ("the proxy stays ... implemented and tested"). It also forces frontend edits during the redesign (`govmapFallback.ts`, `baseLayers.ts`, `runtimeConfigStore.ts`, `mapViewStore.ts`, `ConfigResponse.tiles`). The gain (~2,950 lines) is real, so section 8 lists it as an explicit decision. |
| tiles:P2 | Rejected | `node:http` was chosen on purpose (see the header of `upstream-client.ts`) so the upstream request carries exactly Referer, User-Agent and Accept. `fetch` adds `accept-language`, `sec-fetch-mode` and `accept-encoding`. Whether GovMap's WAF accepts those cannot be verified offline, and the work would be thrown away if tiles:P1 is approved. |
| INFRA-10 | Rejected | Replaces explicit, unit-tested bookkeeping with implicit AsyncLocalStorage propagation across Fastify body parsing, which is a known footgun that needs a new dependency or manual re-binding. That trades clarity for cleverness on the graded audit-trail bullet. |
| INFRA-14 | Rejected | High risk. It drops the shared L2 body cache behind the *caching layer* and *horizontal scaling* story, and changes the health payload, the `X-Cache` values, env vars and compose. |
| S9 | Deferred to the frontend follow-up | Moving the protocol examples out of the public API requires editing `frontend/src/test/fakeSocket.ts` and `frontend/src/realtime/handlers.test.ts`. |
| T3 | Deferred until after all parallel work | `scripts/typecheck-paths.mjs` is the scoped type-check gate that every parallel package in this plan (and the redesign) uses. Delete it together with `scripts/lib/{cli,process,test-support}.mjs` and their tests once nothing runs in parallel. |
| T7 | Deferred to the frontend follow-up | Both options (write E2E specs, or delete the scaffold and `e2eHook.ts`) touch frontend test ids under redesign. SPEC D-1 item 4 names `E2E/layer-switch.spec.ts` as the required proof, so writing the specs is preferred. |
| T10 | Rejected | `env.test.ts` checks that every backend config key appears in `.env.example` (a keep-list guard). The file is the operator catalog of every tunable, and docs-03 now points to it instead of the SPEC section 11.3 table. |
| T15 | Rejected | Saves ~20 lines but loses the readable `backend-1`/`backend-2` instance ids used in logs, metrics, README and the cross-instance demo. It also churns the e2e overlay, README and SPEC. Two explicit services show horizontal scaling plainly. |

**Accepted in part:**

- **S4:** the optional latitude value change to 85.0511287 is rejected. It is frontend-visible, touches SPEC section 9.1, and the 2e-8 difference is harmless.
- **S6(d)(e):** deferred, because they change `segmentRelation`'s return type and `frontend/src/lib/drawGeometry.ts`.
- **T13 item 5:** rejected. Keep the pre-gzip plus `gzip_static`; it is a cheap static-asset optimisation.
- **T16(3):** rejected. Whether `.claude/` is tracked is the user's decision.
- **T16(4):** deferred to the frontend follow-up.
- **RT-1:** the `jitteredDelay` hoist is skipped, because tiles:P5 inlines the retention formula instead.
- **core:P10(f):** skipped. It sweeps many realtime test files for a tiny gain.

## 5. Wave 1: seven parallel packages

### W1-AREAS: areas module, test-only doubles, EXPLAIN on production SQL (backend)

**Owned:**
- `backend/src/modules/areas/**` and `backend/test/integration/areas/**`
- `backend/test/integration/foundation/migrations.int.test.ts`
- `backend/src/infra/cache/in-memory.ts`, `backend/src/infra/cache/in-memory.test.ts`
- `backend/src/infra/drafts/in-memory.ts`, `backend/src/infra/drafts/in-memory-draft-registry.test.ts`, `backend/src/infra/drafts/types.ts`, `backend/src/infra/drafts/types.test.ts` (new)

**Proposals:** AR-1...AR-7, INFRA-3, INFRA-11, core:P1, core:P11 (the areas-kit comment).

**Steps, in order:**

1. **AR-4.** Delete the unreachable `deleted` merge outcome and everything that only serves it:
   - `if (current.deleted)`, `{ kind: 'deleted' }` and `MergeCurrent.deleted` in `merge.ts`, and the matching switch arm in the service;
   - `merge.test.ts:85-94` and the `deleted: false` noise in the fixtures.

   The service's AREA_DELETED guard, which runs before planning, stays.
2. **AR-7.**
   - `Queryable` becomes `DbTx`.
   - Make these module-private: `CHANGE_FEED_LOCK_KEY`, `auditActionFor`, `affectedBboxes`, `toBusPayload`, `failureDetails`.
   - Replace `ACTION_BY_OP` with `` `area.${op}` ``, typed as `AuditAction`.
   - Move `isSameCreate` into `area-input.ts` and delete `replay.ts`.
   - **Exception:** `AREAS_SQL` stays exported, because step 10 imports it.
3. **AR-3.**
   - `insert` becomes `ON CONFLICT (id) DO NOTHING RETURNING id` and returns a boolean.
   - `updateContent`, `softDelete` and `restore` return void and have no RETURNING clause.
   - Delete `MutationRow`, `MutationStamp` and `toStamp`.
4. **AR-2.**
   - `cutPage` keeps rows with `geometry !== null`, written as a type guard.
   - Stop selecting `p.rn` and `p.cum_positions`; the SQL still uses them internally.
   - Delete `BudgetedRow`, `fitsBudget` and their test.
   - Delete the "budget sentinel mapped as item" throw and its test.
   - Adapt the `page-budget.test.ts` row factory. The six `cutPage` scenarios stay.
5. **AR-6.**
   - Inline `#mergeFieldsChangedSince`.
   - Replace `TombstoneRequest` with plain arguments.
   - `CREATE_CHANGED_FIELDS` becomes `MERGE_FIELDS`.
   - Both services import `areasRepository` directly and keep their dependencies in one `readonly #deps`.
   - Use the shared `AreaVersionsQuery` instead of `VersionsQuery`.
   - Drop `BboxPage.zoom` and the `loaded` holder object.
   - Build the list-response literal in `#loadBboxPage`.
   - Inline `sendJsonText` and `registerBboxRoute`.

   `index.ts` keeps the factory that `app.ts` and `platform/retention.int.test.ts` import.
6. **AR-1.**
   - Select geometry as `ST_AsGeoJSON(<geom>, <digits>)::json`.
   - Map each SQL row once, straight to `AreaDto`, `AreaListItemDto`, `AreaVersionDto` or `ChangeEventDto`, calling `.toISOString()` in that one place.
   - Delete the `*Record` types, `PolygonJson`, `isPolygonJson`, `parseGeoJsonPolygon` and the identity mappers.
   - Services, `area-errors`, `mutation-effects` and routes pass DTOs through unchanged. `MutationResult.area` becomes `AreaDto`.
   - The merge code reads `current.geometry.coordinates`.
   - Keep the "area as of this change" rule (`updatedBy` falls back to the creator; a delete version is a tombstone) with 2-3 unit tests, including the actor-null path. Delete the tests that only check fields were copied.
   - First read `backend/src/infra/db/pool.ts`, without editing it, and confirm that its per-pool type parser still parses `json` (OID 114) with the pg-types default.
   - Add `AreaListResponseSchema.parse(page)` to one bbox integration test. Bbox bodies are pre-serialised strings, so the zod serializer never sees them.
   - JSON bodies must stay byte-identical.
7. **INFRA-11** (replaces AR-5 item 1).
   - Delete `infra/cache/in-memory.ts` and its test.
   - `areas-kit.ts` drops `RecordingAreaCache` and the `areaCache` override and uses the production cache.
   - Record invalidations with `vi.spyOn(testApp.container.areaCache, 'invalidate')`.
   - Make the "X-Cache MISS then HIT-L1" test deterministic on the real cache: prime the epoch with one throwaway read, or give the kit its own `REDIS_KEY_PREFIX`.
8. **INFRA-3.**
   - Delete `infra/drafts/in-memory.ts` and its test.
   - Keep the pure "derives the touch throttle" case as `infra/drafts/types.test.ts`.
   - `kit.drafts` becomes `testApp.container.drafts`, the real `RedisDraftRegistry`.
9. **AR-5 items 2-5.**
   - Drop `limiter` from `AreasKit`.
   - Move the http-caching and zoomBucket tests into a new `http-caching.test.ts`.
   - Move the misplaced server-generated-id test out of the "an id that is not a uuid" block.
   - Drop `merge.test.ts:236`.
   - Remove the "wave-1" comment at `areas-kit.ts:3` (core:P11).
10. **core:P1.**
    - `migrations.int.test.ts` uses `AREAS_SQL.findInBbox.text`, `AREAS_SQL.insert.text` and `AREAS_SQL.insertVersionFromCurrent.text` instead of its hand copies. The copy had drifted: it used `<` where production uses `<=`.
    - The EXPLAIN assertions do not change: `areas_geom_live_gist` is used, there is no Seq Scan, and the query runs in 250 ms or less over 12,000 + 3,000 rows.

**Must keep:**
- `lockById`: FOR UPDATE followed by a separate `findById`.
- The change-feed advisory lock, taken after the row lock.
- The three-way field merge.
- The versions endpoints and the `exists()` pre-check.
- The route hook order: authenticate -> zod -> drawRateLimit.
- Service-side failure auditing.
- `findInBbox`: GiST, LOD, culling, keyset pagination, span cap and position budget.
- Cache-aside, and `afterCommit` invalidating before it publishes.
- REPEATABLE READ READ ONLY reads.
- `#isCurrentAdmin`.
- The draft-squatting guard and the idempotent create.
- The sanitise -> 428 -> geometry order.
- Cursor binding.
- ETag/304.
- The metrics.

**Report:**
- To W2-SEAMS: which pure areas modules remain, for `UNIT_COVERAGE_SET`.
- To W2-DOCS: `replay.ts` is removed, `http-caching.test.ts` is added, and the in-memory doubles are gone.

**Verify:** see the structured list; lint, prettier, `typecheck-paths`, unit tests, and the integration filters `areas migrations draft-registry`.

### W1-AUTH: auth and admin modules (backend)

**Owned:**
- `backend/src/modules/auth/**` and `backend/src/modules/admin/**`
- `backend/src/infra/directory/queries.ts`
- `backend/test/integration/auth/**`
- `backend/test/integration/platform/{admin-audit,audit-analytics}.int.test.ts`
- `backend/test/integration/foundation/openapi.int.test.ts`

**Proposals:** A1-A17 (except the script-alias part of A10), core:P11 (the auth-test-kit comment).

**Steps, in order:**

1. **A15.** Type `outcome` as `AuditOutcome` and delete `toOutcome`/`OUTCOMES`.
2. **A12.**
   - Drop the `random` parameter of `generateRefreshToken` and its test.
   - Type `refreshCookieOptions` as `CookieSerializeOptions`.
   - Un-export `REFRESH_TOKEN_BYTES`.
3. **A6.**
   - The refresh-candidate row maps `matched_current` to `matched`, then `decideRotation(row, row.dbNow, ttl)` takes it directly.
   - Inline `UNKNOWN_REFRESH_TOKEN` and delete its frozen-constant test.
4. **A5.**
   - Drop `now() AS db_now` from session insert and rotate.
   - Delete `StampedSessionViewRow`, `StampedSession` and `toStamped`.
   - Max-Age is `REFRESH_TOKEN_TTL_S` for a new session and `refreshCookieMaxAgeS(decision.expiresAt, row.dbNow)` for a rotation.
5. **A4.**
   - One `UserProfile` type (`UserRecord extends UserProfile { disabledAt }`).
   - One `OWNER_COLUMNS` fragment, one `OwnerRow` and one `toOwner`.
   - `toSessionDto`'s `currentSessionId` becomes a plain string.
6. **A14.** Export `ACTIVE_SESSION_PREDICATE` from `infra/directory/queries.ts` and interpolate it in `listActive` and `findActiveWithUser`.
7. **A16.** One `actorAuditFields(actor)` helper, used by AuthService, SessionsService and AdminService.
8. **A3.**
   - One `toAdmission(reply: unknown): LoginAdmission`: a 4-integer shape check, then `evaluateLockout`.
   - Drop the `admitted` element from the Lua reply.
   - `reserved` is true when Redis answered and the attempt is not locked, and false on fail-open.
   - Merge the two decoder test blocks into one table. The Lua script stays the atomic gate.
9. **A1.**
   - Inline the single-use refresh, login and ticket helpers.
   - Keep `#rotate` and `#auditRefreshFailure`.
   - Add one `#activeSession(actor)`.
   - Keep the same statements and the same side-effect order: DB, then Redis, then audit.
10. **A17.** Move `me()` and `issueWsTicket()` into SessionsService and update `auth.routes.ts`.
11. **A13.** Delete the lockout warn log and its KeyedThrottle, and remove `clock` from AuthService and its wiring. The two coalesced audit events and the metric stay.
12. **A2.**
    - Replace `AdminRepository`/`createAdminRepository` with exported functions that take `db`. `AdminService` takes `db`.
    - `AUDIT_STATS_SQL` stays exported.
    - Delete `admin.test.ts:117-166` and `:181-189`.
13. **A9.**
    - Delete `recordFailedQuery`, the two `onError` hooks and `AdminService.recordFailure`/`AdminEndpoint`.
    - The generic audit hook already writes exactly one row for every outcome >= 400 that the service did not record.
    - Success rows keep `{ endpoint, filters }`.
    - Update `admin-audit.int.test.ts` and `admin.test.ts` to the generic `{ code, status }` details. They must still assert exactly one row per call, including 403 before validation, and one failure row for a 400.
14. **A7.**
    - Replace the batched delivery with a sequential loop.
    - `setUserRole`, `disableUser` and `enableUser` return `UserRecord` and throw when no row comes back.
    - Delete the `?? found` fallbacks and `user-admin-script.int.test.ts:124-150`.
    - The `canonicalUsername` guard stays.
15. **A10.**
    - Remove the double argon2 injection seam. `createAuthModule` builds `createPasswordHasher()`.
    - `passwords.test.ts`, `auth-flow.int.test.ts` and `qa-login-username-input.int.test.ts` spy through `vi.mock('@node-rs/argon2', …importOriginal…)`.
    - `auth-test-kit.ts` drops `argonVerify`.
    - Delete `passwords.test.ts:44-57`.
    - Trim `index.ts` re-exports only after grepping `app.ts`, `scripts/user-admin.ts` and `backend/test`.
16. **A8.**
    - Fold the auth-flow OpenAPI block into `EXPECTED_ERRORS` in `openapi.int.test.ts` (register 409; login 401, 403; refresh 401; logout 401; me 401; sessions 401; session delete 401, 404; ws-ticket 401).
    - Drop the duplicate cookie regexes in `refresh-rotation.int.test.ts:87-92`, keeping the absolute-expiry cap check.
    - Drop the <= 8 s real-time wait in `ws-ticket.int.test.ts:85-90`; the PTTL assertion stays.
    - Drop `qa-login-username-input.int.test.ts:133-167`.
17. **A11.**
    - Cut comments that restate SPEC section 6.2/section 10.4 or QA history down to one line plus the SPEC section.
    - Keep every non-obvious "why": FOR SHARE, FOR UPDATE re-evaluation, the dummy hash, preValidation before validation, fail-open.
    - Remove the "wave-1" comment at `auth-test-kit.ts:49`.

**Must keep (reviewer keep-list):**
- Atomic Lua admission with reserve, release and reset.
- The `CanonicalUsername` brand.
- The dummy hash and byte-identical 401 bodies.
- `FOR SHARE OF u`.
- The rotation transaction with its 10 s race window.
- Revocation-notifier ordering.
- User-admin re-delivery.
- ws-ticket 503 and claims read from the DB.
- Per-route rate-limit buckets and `Cache-Control: no-store`.
- Every specific audit reason.
- Admin: keyset cursor bound to the filters, <= 31-day window, BRIN-bounded aggregates, role checked in preValidation.
- The two-step session revoke.
- The constraint-name check in `isUsernameTaken`.
- `isWellFormedRefreshToken`.
- `requireSessionActor`.
- The palette golden vectors.
- Every SPEC section 12.3-named test file.

**Report to W2-DOCS:** the SPEC section 10.4 `admin.audit_query` row gets the failure outcome and generic details.

### W1-REALTIME: realtime module and WS test clients (backend)

**Owned:**
- `backend/src/modules/realtime/**`
- `backend/test/integration/realtime/**`
- `backend/test/helpers/ws-client.ts`

**Proposals:** RT-1...RT-11, core:P8.

**Steps:**

1. **RT-2.**
   - `timers.ts` exports `unrefTimeout(cb, ms): Cancel`, which keeps the `MAX_TIMER_DELAY_MS` clamp, and `unrefImmediate(cb): Cancel`.
   - Remove `timers` from the 8 dependency objects and from the 3 tests, which already use `vi.useFakeTimers()`.
   - Fold `createRealtime`, `RealtimeRuntime` and `RealtimeOptions` into `createRealtimeModule`.
   - Clock stays injected, and `jitteredDelay` keeps its `random` parameter.
2. **RT-1.**
   - Add `repeat(nextDelayMs, task, onError): Cancel`. It schedules the next run only after the previous one settles, and its timer is unref'd.
   - Heartbeat becomes `startHeartbeat(...)`.
   - Presence and SessionRevalidator use `repeat`.
   - `tick`, `refresh` and `sweep` become private.
3. **RT-5.**
   - `runNow()` becomes a promise chain, and `#round` never throws.
   - The unit test asserts that 3 calls give 3 sequential rounds that never overlap.
4. **RT-3.**
   - Delete the `RealtimeSettings` rename layer.
   - Components take `Pick<AppConfig, …>` and use the env names directly.
   - Inline `welcomeLimits`.
   - Keep `PROTOCOL_LIMITS`.
   - The welcome `limits` object must stay identical.
5. **RT-6.**
   - Move upgrade authorisation into a new `upgrade-auth.ts` exporting `authorizeUpgrade`.
   - Build a rejection object only when rejecting.
   - Drop the `string[]` subprotocol branch.
   - Rename `gateway.test.ts` to `upgrade-auth.test.ts`.
   - Delete `ConnectionIdentity`/`toIdentity`.
   - The `wsConnections` gauge is set only by the scrape sampler.
6. **RT-7.**
   - The handshake becomes the first task on `connection.inbound`.
   - Delete `earlyFrames`, `maxEarlyFrames`, `replayEarlyFrames` and `#openings`. `Connection.#beforeReady` stays.
   - Confirm that a flood before welcome stays bounded.
   - Add the missing gateway.int test: send `ping` with a `ref` right after `open`; `messages[0]` must be welcome, followed by the pong.
7. **RT-8.**
   - Delete the test-only getters and APIs, and publish's `reason` argument.
   - Inline `countForUser`.
   - Make `wasRecentlyOwned` private.
   - Drop the `closeReason` truncation and the `OutboundSink` adapter.
   - Derive `LockScope` from the protocol type.
   - Rewrite the affected tests to check observable behaviour. Keep `WindowCounter.count`.
8. **RT-9.** Write the drafts ownership steps once. The limiter consume stays strictly before claim.
9. **RT-10.** `denied(action, code, connection, targetId, extra = {})`. Delete `withoutTarget` and the unused `lock.release` member.
10. **RT-11.**
    - The store serialises presence entries.
    - Pass `connection.draft` directly.
    - Sort with `localeCompare`.
    - The Redis JSON stays unchanged.
11. **RT-4 + core:P8.**
    - In `ws-client.ts`, delete the dead `connectWs`, `WsConnection`, `ReceivedMessage`, `unwrap` and `fetchTicket`.
    - Export `untilOpen(socket)`, which attaches the `message` listener before `open`.
    - Give `openWs` optional `ip`, `autoPong` and `origin: null` options. Existing callers keep working: `foundation/global-rate-limits`, `foundation/shutdown` and `realtime/ws-auth`.
    - The harness wraps the shared client and adds `clientPool(testApp)` and `fakePresenceEntry()`.
    - Leave the harness's fixture SQL alone; W2-SEAMS moves it.

**Must keep:**
- The two-lane outbound queue and the 1013 close.
- The token bucket and the 4429/4400 rules.
- The invalid-accounting ring.
- Draft-coalescer ordering.
- The pre-101 upgrade checks and the capacity reservations.
- Re-validation and the re-arm past `MAX_TIMER_DELAY_MS`.
- The degradation branches.
- Fan-out rules.
- The Lua scripts.
- zod parsing of values read back from Redis.
- Coalesced audit denials.
- The metrics.
- `SerialTaskQueue`.
- `#beforeReady`.
- `gateway.stop()`.
- `presence-status`.
- Lane typing.
- All SPEC section 12-named test files.

**Report to W2-DOCS:** SPEC section 7.8 loses the 64-early-frame 4429 rule.

### W1-TILES-RETENTION-META: tile proxy internals, retention, meta (backend)

**Owned:**
- `backend/src/modules/{tiles,retention,meta}/**`
- `backend/test/integration/platform/{tiles,retention}.int.test.ts`
- `backend/test/integration/platform/support/{mock-upstream,retention-fixtures}.ts`

**Proposals:** tiles:P3, P4, P5, P6, P7, P8, P10. The proxy itself stays (D-1 item 3). tiles:P1 and tiles:P2 are not done.

**Steps:**

1. **tiles:P3.**
   - One classifier over `UpstreamResponse`.
   - A table for `describeUpstreamProblem`.
   - `#fetch` returns the tile or throws the `AppError`; `FetchOutcome` and the switch go.
   - Count the tile-request metric once, in the route, through a code->result map. The label values stay exactly as they are today.
   - Drop the impossible content-type default.
2. **tiles:P6.**
   - Delete the settings rename layer and the dead catalog fields.
   - The catalog becomes a `const LAYERS = … satisfies Record<GovmapTileLayer, …>`.
   - Export the layer zoom ranges, and have `meta.service.ts` read them. The `/api/v1/config` body stays ortho 4-20 and labels 7-19.
3. **tiles:P7.**
   - Single-flight becomes a `Map` inside the service.
   - `Semaphore.acquire()` resolves `null` when refused.
   - `maxWaitMs` becomes required, and the impossible guards go.
   - Delete the test-only getters; the tests assert behaviour.
4. **tiles:P4.**
   - One status vocabulary, and a stop is no longer an exception.
   - One `purgeBatch` over a `Record<Entity, NamedSql>`.
   - `pgErrorCode` is imported from `infra/db/execute.ts`, where it stays.
   - The SQL is unchanged, including the purge watermark.
5. **tiles:P5.**
   - Delete `schedule.ts` and `schedule.test.ts`, inline the two formulas into the job, and move `MAX_AREA_BATCH_SIZE` into the service.
   - Add the random->1 edge case (1.1x the interval) to the job test.
6. **tiles:P8.**
   - Settings become a `Pick<AppConfig, …>`.
   - The job loses `enabled` and `#started`, and keeps `#stopped`.
   - When retention is disabled, the module has no start/stop.
7. **tiles:P10.** Delete the dead `CLIENT_ERRORS_PER_MINUTE` export.

**Must keep:**
- The circuit breaker.
- The upstream wait budget and the bounded semaphore queue.
- Validation before any upstream call.
- The WAF-403 vs AccessDenied classification, with throttled logs.
- The LRU with its negative cache.
- 304 handling.
- The Sec-Fetch-Site guard.
- The retention advisory lock.
- One transaction per batch, with a statement timeout.
- The record written while the lock is held.
- `requestStop()`.
- The `index.ts` factories.
- The client-errors pipeline.

### W1-INFRA: infra adapters, composition root, health (backend)

**Owned:**
- `backend/src/infra/{audit,auth,db,events,http,metrics,ratelimit,redis}/**`
- `backend/src/infra/cache/{index,redis-area-cache,key-plan,key-plan.test,l2-codec,l2-codec.test,types}.ts`
- `backend/src/infra/drafts/redis-draft-registry.ts`
- `backend/src/infra/directory/{directory,types}.ts`
- `backend/src/infra/{lifecycle,keyed-throttle,clock,logger,timeout}.ts` (`timeout.ts` is new)
- `backend/src/{container,app}.ts`
- `backend/src/modules/health/**`
- `backend/test/integration/platform/{audit,area-cache,draw-rate-limit}.int.test.ts` and `platform/support/realistic-page.ts`
- `backend/test/integration/foundation/{audit-hook,health,event-bus,db-pool,metrics,timeouts,errors,two-instances,global-rate-limits,security,draft-registry}.int.test.ts`

**Proposals:** INFRA-2, INFRA-4 (+core:P4 a, c), INFRA-5, INFRA-6, INFRA-7, INFRA-8, INFRA-9, INFRA-12, INFRA-13, tiles:P9, core:P11 (the `app.ts` part).

**Steps:**

1. **INFRA-2.** One `ratelimit/redis-draw-limiter.ts` class does both jobs:
   - it runs the sliding-window Lua;
   - on failure it bumps the metric, logs a KeyedThrottle warning and uses the in-memory fallback.

   Delete `resilient.ts`, `resilient.test.ts`, `ratelimit/index.ts` and the separate primary. Keep `in-memory.ts` and its test.
2. **INFRA-4 + core:P4(a)(c).**
   - Delete `cache/index.ts`, `audit/index.ts` and `InfraDeps`.
   - `container.ts` constructs the components directly.
   - Drop `FALLBACK_MAX_USERS` and the unused `clock` override.
   - Delete `audit.int.test.ts:226-243`.
   - `createContainer` stays async for now; W2-SEAMS changes that.
3. **INFRA-5.**
   - Failures are either transient or not. A non-transient batch failure falls back to per-row inserts: a row that still fails is `rejected`, and a transient per-row failure requeues the rest.
   - Shutdown is one bounded flush, and whatever is left is counted `failed`.
   - Delete the recursive bisection, retry-once, `#gaveUp`/`#abandon`, `raceTimeout`/`sleep` and `shutdownBudgetMs`.
   - Replace the three removed unit tests with one per-row test, and rename the poison-row integration test.
   - The reviewer cited `system/audit-trail.int.test.ts`, which does not exist. The proof is `audit.int` plus `audit-hook.int`.
4. **INFRA-6.**
   - Remove the L1 "memory hygiene" subscription, the corrupt-generation branch and the never-passed options, and delete `area-cache.int.test.ts:195-206`.
   - Generation and epoch correctness stays, and so does L2.
5. **INFRA-7.**
   - One `infra/timeout.ts` `withTimeout`, moved from health, with a unit test.
   - It replaces the hand-rolled races in `buffered-writer`, `pool`, `metrics` and `redis/client`.
   - Share one `QUERY_TIMEOUT_MARGIN_MS`.
6. **INFRA-8.**
   - Add `infra/db/errors.ts` with `isConnectionFailure`, used by `problem.ts` and `buffered-writer.ts`.
   - `pgErrorCode` stays exported from `infra/db/execute.ts` under the same name.
   - The `problem.test.ts` table passes unchanged.
7. **INFRA-9.**
   - Derive the bus channel and payload types from `BUS_PAYLOAD_SCHEMAS`.
   - Delete `hasSubscribers`, `published` and `simulateReconnect`.
   - Keep `publishedWithChannel`/`publishedOn`.
8. **INFRA-12.** Use `decorateRequest('logContext', null)` and assign it in `onRequest`.
9. **INFRA-13.**
   - Declare the rate-limit scopes once, keeping `tiles`.
   - Remove the third draw-limit warn log.
   - Remove the never-passed options.
   - Un-export module-local symbols, but only after grepping `backend/src` and `backend/test`.
10. **tiles:P9.**
    - `evaluateReadiness({ db, redis, cacheRedis, isShuttingDown })` returns `{ status, checks }`; the route adds instance, version and uptime.
    - Un-export the helpers.
    - Fix the `'connect <SQLSTATE>'` wording.
    - The `ReadyResponse` body stays unchanged.
11. **core:P11 (`app.ts`).** Replace the wave-history header, drop `SnaplandApp.modules` if nothing reads it, and make `connectionsCheckingInterval` local.

**Not here:** INFRA-10 and INFRA-14 are rejected, and INFRA-1 belongs to W1-CORE.

**Must keep:** the whole infra keep-list, including:
- `ScopedRedisStore`;
- key-plan, epoch and generation;
- the coalescer;
- normalisation;
- the generic audit hook;
- `toAppError` and the typed errors;
- the request timeout;
- CORS and helmet;
- trust-proxy;
- pool timeouts, the int8 parser and `sql()` named statements;
- the migrations lock;
- the per-container metrics registry;
- three named Redis clients;
- `lua.ts`;
- the bus's validation and reconnect;
- the auth adapters;
- the directory ports;
- the draft registry;
- shutdown handlers;
- the lifecycle helpers;
- keyed-throttle.

### W1-CORE: entry point, config, scripts, test setup (backend)

**Owned:**
- `backend/src/main.ts` and `backend/src/config/**`
- `backend/src/scripts/{export-openapi,migrate,smoke,user-admin,scripts.test}.ts`
- `backend/src/infra/{shutdown,cli}.ts`
- `backend/test/integration/foundation/shutdown.int.test.ts`
- `backend/test/helpers/wait-for.ts`, `backend/test/setup/{test-database,env}.ts`
- `backend/package.json`, `backend/vitest.all.config.ts`
- `.env.example`

**Proposals:** INFRA-1 = core:P3, core:P5, core:P6, core:P7, core:P9, core:P11 (scripts, cli and helpers), A10 (the script aliases).

**Steps:**

1. **INFRA-1.**
   - Delete `abortStartup`, `settleWithin`, `StartupFailure` and `TeardownOutcome`.
   - `main.ts` becomes log fatal, then `process.exit(1)`.
   - Delete the `abortStartup` tests. The EADDRINUSE spawn test stays, and now expects `'startup failed'`.
2. **core:P6.**
   - `loadConfigFromEnv()` uses `process.loadEnvFile` when `<repo>/.env` exists.
   - Delete `dotenv.ts`, `readProcessEnv`, `parseConfig` and `ParsedConfig`.
   - `LOG_PRETTY` is forced off in production inside the schema.
   - `loadConfig(source)` keeps its signature for tests.
3. **core:P5.**
   - Remove `LOGIN_FAILURES_PER_USER_IP`, `LOGIN_FAILURES_PER_USER` and `BOOTSTRAP_ADMIN_USERNAMES` from the schema, `.env.example` and the tests.
   - `CACHE_REDIS_URL` gets a `.transform`, so `AppConfig` is plain `z.output`. The field's type must stay identical.
   - The `CONFIG_KEYS` <-> `.env.example` sync test stays green.
4. **core:P7.** Delete `smoke.ts`, its tests, its npm script and its exclude entry. Keep the `seed` entries; W2-BENCH implements the script.
5. **core:P9.** Delete the mock-driven script tests. Keep `--help`, the bad-flag table and the migration-failure exit.
6. **core:P11.**
   - Delete the `USER_ADMIN_COMMANDS` aliases.
   - `summaryOf` becomes a spread.
   - Drop the unused `level` parameter in `cli.ts`.
   - Remove the "wave-1" comments in `wait-for.ts` and `test-database.ts`.

**Must keep:**
- The zod schema with its cross-field rules and its string-or-typed parsers (no `z.coerce`).
- The 50 / 60000 draw-limit defaults.
- `TRUST_PROXY`.
- `INSTANCE_ID`.
- Exact CORS origins.
- `CONFIG_KEYS` clearing.
- `reportEarlyFailure` and the degraded start.
- `run(argv, deps)` for migrate, user-admin and export-openapi.
- `parseScriptArgs` and `isEntryPoint`.
- User-admin exit codes.
- The `APP_VERSION` test.

### W1-TOOLING: repo scripts, root configs, Docker, compose, nginx (devops)

**Owned:**
- `scripts/{setup-env,check-publishable,check-banned-deps,clean-copy}{.mjs,.test.mjs}`
- `scripts/banned-packages.json`, `scripts/lib/banned.mjs`, `scripts/vitest.config.mjs`, `scripts/tsconfig.json` (new)
- `package.json`, `package-lock.json`
- `eslint.config.js`, `tsconfig.scripts.json`
- `.prettierignore`, `.gitattributes`, `.dockerignore`, `.gitignore`
- `backend/Dockerfile`, `docker/**`, `docker-compose.yml`
- `loadtest/{package.json,tsconfig.json,vitest.config.ts,coverage/**}`

`scripts/typecheck-paths.mjs`, its test and `scripts/lib/{cli,process,test-support}.mjs` (with their tests) stay untouched until the T3 follow-up.

**Proposals:** T1 (partial), T2, T4, T5, T6 (the scaffold part), T8, T9 (the `cli` service part), T11, T12, T13 (items 1-4), T14, T16 (items 1-2).

**Steps:**

1. **T1.** Rewrite `setup-env`, `check-publishable` and `check-banned-deps` as plain, self-contained scripts:
   - `// @ts-check`, a top-level main, `console.error` diagnostics, `process.exitCode`, and `spawnSync` (`shell: true` only for npm on Windows);
   - main guarded by `process.argv[1] === fileURLToPath(import.meta.url)`;
   - they export only the pure functions their tests need.

   Drop the injected deps, the JSON summaries and the `--help`/`--root` flags. `check-publishable` keeps its content rules and the name rule, skips files over 1 MB or containing a NUL byte, and drops the git-ignored crash-dump branch. Tests exercise real behaviour on a temp dir and on literal strings. `setup-env` keeps the 48-byte secret, writes with flag `wx` and has no dependencies. Drop the `no-console` scripts rule.
2. **T2.** Delete `clean-copy.mjs` and its test.
3. **T4.**
   - Inline the ban list in `check-banned-deps.mjs`, and delete `banned-packages.json` and `lib/banned.mjs`.
   - Delete the R45 import-ban and deep-import regex plumbing in `eslint.config.js`.
   - `check:deps` (part of `verify`) stays the proof.
4. **T5.**
   - Delete the `ws-schema:export` script.
   - Delete the root devDependencies `tsx` and `@vitest/coverage-v8` only after a grep confirms nothing at root level uses them.
   - Delete `scripts/vitest.config.mjs` and set `test:scripts` to `vitest run --dir scripts`.
   - The scripts tsconfig includes only `*.mjs`.
   - Delete the dead k6 ESLint block.
5. **T6 (scaffold).** Delete the empty loadtest workspace (package, tsconfig, vitest config, coverage), its root workspace entry and the `loadtest/.tokens` ignores.
6. **Lockfile.** Run `npm install --package-lock-only --ignore-scripts` once. If `package-lock.json` changed within the last few minutes (the redesign may be installing), wait. Never revert other people's changes.
7. **T11.**
   - Drop the rules that `strictTypeChecked` already sets.
   - `tsconfig.scripts.json` moves to `scripts/tsconfig.json`, and the root `typecheck` uses `tsc -p scripts`.
   - Delete the no-op `eslint.config.js` block.
   - `eslint --print-config` must give the same effective rule set before and after.
8. **T8.**
   - The postgres healthcheck probes TCP: `pg_isready -h 127.0.0.1 …`.
   - Delete `wait-for-postgres`; `migrate` depends on postgres being `service_healthy`.
9. **T9.** Delete the `cli` service; the replacement is `docker compose exec backend-1 node dist/scripts/user-admin.js …`. Keep the `seed` service.
10. **T12.**
    - Delete the backend image HEALTHCHECK and the duplicate in the nginx image.
    - Delete the `healthcheck: disable: true` blocks, but only if no shared compose anchor defines a healthcheck.
    - `HOST`/`PORT` are set only where needed.
11. **T13 (items 1-4).**
    - Delete the `/metrics` 404 locations and `location = /index.html`.
    - Merge the two `/docs` locations.
    - Shorten the long comments.
    - Keep pre-gzip.
12. **T14.** Trim header comments that restate the README.
13. **T16 (items 1-2).** Remove `.prettierignore` entries that duplicate `.gitignore`, and the redundant binary lines in `.gitattributes`.

**Must keep (keep-list):**
- The `verify` pipeline.
- Strict `tsconfig.base.json`.
- The ESLint HTML-sink and single-env-reader rules.
- Two replicas behind `least_conn` + `resolve`.
- Separate `redis` (noeviction) and `redis-cache` (allkeys-lru).
- The `migrate` one-shot.
- Postgres tuning and `pg_stat_statements`.
- Readiness healthchecks and `depends_on`.
- `restart: true`.
- Container hardening.
- The multi-stage build with the argon2 musl probe.
- tini and the stop signals.
- The `.dockerignore` allow-list.
- The nginx problem+json pages, request-id, `$uri`-only log and `/ws` log suppression.
- Proxy header overwrite and the `proxy_next_upstream` rules.
- Timeouts and body limit.
- CSP.
- `/tmp` temp paths.
- The tile-cache location.

**Report to W2-DOCS:** the README lines about `wait-for-postgres`, `cli`, `clean-copy` and `loadtest`, and SPEC section 3.8, section 12.1 and the R45 proof.

## 6. Wave 2: four packages, started after all wave-1 packages report done

### W2-SHARED: shared contracts package (backend)

**Owned:**
- `packages/shared/**`
- `backend/src/infra/http/{errors,problem,problem.test,openapi}.ts`
- `backend/src/infra/cache/{key-plan,key-plan.test}.ts`
- `backend/src/modules/meta/meta.service.ts`
- `backend/src/modules/realtime/{messages,dispatch}.ts`
- `backend/src/modules/tiles/{tile-request,tile-request.test}.ts`
- `backend/test/integration/realtime/gateway.int.test.ts`

**Proposals:** S1, S2, S3, S4 (without the latitude value change), S5, S6 (a)-(c), S7, S8, S10.

**Rules:**
- Make no frontend edits. Every symbol `frontend/src` imports keeps its name, type and value. That includes the `LIMITS`/`REALTIME` keys it reads, `segmentRelation`, `validatePolygon().issues`, `SERVER_MESSAGE_EXAMPLES`, `CLOSE_CODES`, `GeometryErrorCode`, `DRAFT_DECIMALS` and `EQUATOR_METERS_PER_PIXEL_Z0`.
- Before editing, save baselines in your scratchpad: the output of `npx tsc -p frontend/tsconfig.json --noEmit --pretty false` and of `npm run test -w @snapland/frontend`. Afterwards there must be no new diagnostics and no new failing tests.

**Steps:**

1. **S1.** Rewrite sanitize with regex literals and one justified `no-control-regex` disable, keeping the exact step order (see the proposal). `sanitize.test.ts` stays unchanged.
2. **S2.** Build the unions inline and delete the ~50 per-message schema exports. Derive `CLIENT_MESSAGE_TYPES` and `SERVER_MESSAGE_TYPES`, and back the type guards with a Set. `gateway.int.test.ts` asserts through `parseServerMessage`.
3. **S3.**
   - Delete code with no production caller: `openRingArea`/`openRingPerimeter` (replaced by one `geodesicArea` open-ring test), `bboxOfPolygon`, `bboxUnion`, `bboxExtentDeg`, `tileIntersectsBbox` (the backend uses `bboxesIntersect(tileBounds(…), ISRAEL)`), `isErrorCode`, the three unused `REALTIME` keys, `LIMITS.draftDecimals` and the `CloseCode` type.
   - Delete their tests.
4. **S4.**
   - One `ERRORS` table of status and title. The backend reads `ERRORS[code]`, and problem+json output stays byte-identical.
   - Arrays that nothing iterates become union types.
   - One `PositionSchema`.
   - One polygon schema, keeping the `ListGeometry` alias.
   - The decimals live only in `precision.ts`.
   - `LIMITS.maxLatitude` is the single latitude constant (value unchanged), and `DEG` is defined once.
5. **S5.**
   - Delete the tests that only re-check constant values.
   - Keep the palette drift test and the error-catalog completeness test.
   - Drop `--passWithNoTests` from shared.
6. **S6 (a)-(c).**
   - Drop `stage` from the validation result.
   - One issue builder.
   - Reuse `probe`.
7. **S7.**
   - `10 ** decimals`.
   - Drop the `lodForZoom` RangeError and its test.
8. **S8.** Move the critical-lane type into `realtime/messages.ts` and `CACHE` into `key-plan.ts`.
9. **S10.**
   - Barrel and export nits.
   - Drop the per-ring transport cap; the total cap still rejects the 10,001-position ring.
   - Name `PG_INT_MAX`.

**Must keep:**
- Validator stages 1-12, including NON_FINITE and `isCollinearRing`.
- Geodesic area with its fixtures.
- Precision and normalize.
- `RATE_LIMITS` 50 / 60000.
- Tile coverage.
- LOD.
- The Web-Mercator vectors.
- Strict transport schemas.
- Strict-client / loose-server parsing.
- The barrel and the `exports` field.
- Coverage 90 % lines / 85 % branches.
- `testing/fixtures.ts`.

### W2-SEAMS: cross-package seams and the unit-coverage set (backend)

**Owned:**
- `backend/src/{container,main}.ts`
- `backend/src/scripts/{export-openapi,user-admin,scripts.test}.ts`
- `backend/test/helpers/{users,test-app}.ts`, `backend/test/setup/global-setup.ts`
- `backend/test/integration/auth/{auth-test-kit,auth-flow.int.test,qa-login-username-input.int.test}.ts`
- `backend/test/integration/realtime/realtime-harness.ts`
- `backend/test/integration/platform/support/retention-fixtures.ts`
- `backend/vitest.config.ts`

**Proposals:** core:P4(b), core:P10 (a)-(e), core:P12, core:P11 (leftovers), and the coverage-set edits requested by AR-1, INFRA-2, INFRA-3, INFRA-11 and tiles:P5.

**Steps:**

1. **core:P4(b).**
   - `createContainer` becomes synchronous; drop `await` at every call site (grep).
   - Remove the `ContainerOverrides` fields that no test uses any more (grep).
2. **core:P10 (a)-(e).**
   - Remove unused `createUser` options and `captureLogs`.
   - One username helper and one bearer helper.
   - `createSession`, `disableUser` and `revokeSessionInDb(reason)` fixture SQL moves into `test/helpers/users.ts`, and the auth kit, the realtime harness and the retention fixtures import it from there.
3. **core:P12.**
   - The test JWT secret is always random.
   - `DEVELOPER_SETTING` is narrowed to `TEST_*`.
   - Drop the duplicate prefix re-check.
   - Un-export file-local helpers.
4. **core:P11 leftovers.** The stale comments in `users.ts` and `vitest.config.ts`.
5. **`UNIT_COVERAGE_SET`.**
   - Remove the deleted files: `infra/cache/in-memory`, `infra/ratelimit/resilient`, `infra/drafts/in-memory`, `retention/schedule`, and `areas.mapper` if it is gone.
   - Add new pure modules that have unit tests, for example `infra/timeout.ts`, `modules/areas/http-caching.ts` and `infra/drafts/types.ts`.
   - The thresholds do not change (lines 85, branches 80, functions 85).

### W2-BENCH: seed, one k6 load test, benchmark results (devops)

**Owned:**
- `backend/src/scripts/seed.ts` (new) and `backend/src/scripts/seed.test.ts` (new)
- `loadtest/**` (a new plain k6 file)
- `docs/BENCHMARKS.md` (new) and `docs/benchmarks/**`
- `docker-compose.yml` (the `seed` service only)
- `eslint.config.js` (one block for `loadtest/*.js` with the k6 globals)

**Proposals:** core:P2 (fix by implementing), T6 (the k6 script and results), T9 (the seed part).

**Steps:**

1. **`seed.ts`.**
   - Use the existing `run(argv, deps)` + `parseScriptArgs` pattern and `loadConfigFromEnv()`, not `createContainer`.
   - Create N users with `SEED_USER_PASSWORD`.
   - Insert at least 12,000 valid polygons in one Israeli region, plus some elsewhere, through the production statements `AREAS_SQL.insert` and `AREAS_SQL.insertVersionFromCurrent`, in batched transactions.
   - The script is idempotent.
   - Flags follow the documented `--count`, `--region-count` and `--seed`.
   - Unit-test only the pure parts.
2. **Compose.** The `seed` service runs it. Drop the `.tokens` mount if k6 logs in by itself.
3. **`loadtest/bbox.js`.**
   - It logs in as the seeded users.
   - Scenario A: bbox GET pages over random viewports in the seeded region.
   - Scenario B: POSTs at 50 per minute per user or fewer, plus one burst that proves the 429.
   - It records p50, p95 and p99 latency, throughput, error rate and the `X-Cache` mix.
4. **Run.** Use only the throwaway `snapland-bench` project on alternate ports, then `down -v` that project.
5. **`docs/BENCHMARKS.md`.**
   - Machine, dataset, exact commands, and the measured numbers copied from the raw output (never invented).
   - The EXPLAIN evidence from the migrations acceptance test.
   - Load-testing considerations: the rate limit, the pool, WS fan-out.
   - The README is not edited here; W2-DOCS links to this file.

### W2-DOCS: SPEC <= 1,500 lines, README graded sections, ADR hygiene (docs)

**Owned:**
- `docs/SPEC.md`
- `docs/archive/**` (new)
- `docs/adr/0001…0009` (not 0010)
- `README.md`
- `docs/openapi.json` (generated)
- `e2e/playwright.config.ts` (a comment only)

**Proposals:** docs-01...docs-11 (docs-09 only under the condition in step 5).

**Steps:**

1. **docs-02.**
   - Move SPEC section 14, section 17, section 18 and section 19 verbatim to `docs/archive/spec-history-2026-09.md`, with a one-line header saying it is historical and not maintained. The repository has no commits yet, so git holds no copy.
   - Keep the section 0-section 13, section 15 and section 16 headings; code cites them 788 times.
   - Strip the inline v1.x and "measured on" narratives, keeping each number once.
   - The section 19.3 E2E gotchas become a comment in `e2e/playwright.config.ts`.
   - The two section 18.4 rationales that are missing from section 7.6 move into section 7.6.
2. **The user decisions.**
   - One table near the top lists D-1, D-2, D-4, D-5 and D-6 (there is no D-3), with their text kept.
   - The D-4...D-6 block stays intact unless step 5 applies.
3. **docs-03.**
   - Replace copies of DDL, TypeScript signatures, pins, SQL, Lua, env tables and config with pointers.
   - Keep: the ER diagram, a one-row-per-table schema summary, the index table, the bbox contract, the LOD table and the budgets.
4. **docs-04, docs-05, docs-06, docs-07, docs-08, docs-10 and docs-11 as proposed.**
   - Keep one section 12.1 row for `typecheck-paths.mjs` until the T3 follow-up.
   - Document the clean-checkout replacement for `clean-copy` in one line.
   - The section 1 traceability table marks missing proofs as *pending*.
   - Generate `docs/openapi.json` with the backend `openapi:export` script.
5. **docs-09 condition.** Condense section 8.6 and the D-4...D-6 notes only if the orchestrator confirms that the redesign workflow has finished. Otherwise leave that text byte-identical, and reach 1,500 lines or fewer elsewhere.
6. **docs-01 (README).**
   - Add Architecture & technical decisions, Performance & optimization (linking `docs/BENCHMARKS.md`, with no invented numbers), Security measures, Known limitations, Future improvements & scaling, and Testing approach.
   - Add the GovMap legal caveat.
   - Fix the broken or stale commands: seed, `cli` -> `docker compose exec`, `wait-for-postgres`, e2e marked pending, loadtest now k6.
7. **Apply every *Doc follow-up* from the other packages.** The known ones:
   - section 10.4: the admin row (A9), per-row audit fallback (INFRA-5), request-audit tracker unchanged.
   - section 7.8: no early-frame cap (RT-7).
   - section 10.2: memory-hygiene sentence removed (INFRA-6).
   - section 3.3 and section 12.4: file lists (INFRA-2/3/4/11).
   - section 11.3 and section 10.7.7: removed env vars (core:P5).
   - section 12.1: smoke and clean-copy removed (core:P7, T2).
   - section 3.8: script rules (T1).
   - R45 proof becomes `check:deps` (T4).
   - The `CACHE` location (S8).
   - Max-latitude wording (S4).
   - `ws-schema` (T5, docs-08).
   - Compose services (T8, T9).

## 7. Final gate

Once all four wave-2 packages report done, the orchestrator runs `npm run verify` once more from the repository root. It also runs `cd backend && npx vitest run -c vitest.integration.config.ts --maxWorkers=2`. Failures inside `frontend/**` that come from the redesign in progress are reported, not fixed.

## 8. Decisions for the product owner

1. **tiles:P1: remove the default-off GovMap 2025 proxy?** This saves about 2,950 lines and the Referer caveat, but reverses D-1 item 3 and needs frontend edits (`govmapFallback.ts`, `baseLayers.ts`, `runtimeConfigStore.ts`, `mapViewStore.ts`, `ConfigResponse.tiles`), so it would run after the redesign. The graded satellite view stays met by the ITM path.
2. **T7: E2E suite.** Write 2-3 specs after the redesign (recommended, because D-1 item 4 names `E2E/layer-switch.spec.ts` as the proof), or delete the scaffold.
3. **`.claude/` in the graded repository** (T16 item 3): track it or ignore it.

## 9. Follow-ups after this plan

- **T3.** Delete `scripts/typecheck-paths.mjs`, its test and `scripts/lib/{cli,process,test-support}.mjs` with their tests once no parallel workflow runs.
- **Frontend (after the redesign):**
  - S6(d)(e): make `segmentRelation` return `IntPoint | null`, and have `frontend/src/lib/drawGeometry.ts` use a shared `foldPoint`.
  - S9: move the protocol examples out of the shared public API, and have the frontend test fakes build from `frontend/src/test/factories.ts`.
  - T16(4): move `tokens.css` under `frontend/src`.
  - docs-09, if it was skipped.
  - The E2E decision (T7).
  - A frontend simplification audit under the same rules.

---

## Addendum: user decision D-7 (2026-09-29)

The product owner chose to **delete the GovMap 2025 tile proxy**. Proposal `tiles:P1` moves from deferred to accepted.

- **Backend (W1-TILES-RETENTION-META):** remove `backend/src/modules/tiles/**` with its tests, config and wiring. `/api/v1/config`
  keeps `tiles.govmap.enabled: false` until the frontend follow-up removes it.
- **Tooling (W1-TOOLING):** remove the nginx tiles location, cache zone and volume, and the `GOVMAP_*`/`TILE_*` variables. Keep the
  CSP hosts the frontend still uses, including `cdn.govmap.gov.il` for the 2022 ITM imagery.
- **Docs (W2-DOCS):** record D-7. It supersedes D-1 item 3 and ADR-0007's proxy.
- **Frontend follow-up:** after the Studio redesign, drop the proxy `aerial` group and the fallback for it. The backend then drops the
  config field.

## Addendum: user decision D-8 (2026-09-29), email as username

This ships as its own small change before the simplification waves. The simplification packages start from the result.

- **Shared pattern:** `LIMITS.usernamePattern` accepts either the handle form `^[A-Za-z0-9_.-]{3,32}$` or an email address:
  - total length up to 254;
  - the domain must contain a dot;
  - no whitespace.
- **Uniqueness and sign-in:** unchanged. Both use `lower(username)`, via the existing `users_username_lower_uq` index.
- **Migration 0010:** relaxes `users_username_format_ck` to the new pattern. Down restores the old pattern and fails loudly if email
  usernames exist.
- **Display name:** when it is omitted and the username is an email, it defaults to the part before the `@`. Other users never
  receive the email: presence and `UserRef` carry `displayName` only. Verify this and keep it.
- **Frontend:** the form label becomes "Username or email", with matching hint and error copy, and client validation uses the shared
  pattern.

---

## Result (2026-09-29, integration gate)

All eleven packages reported done and passed review. The gate then applied the outstanding cross-package requests, made the
repository green, and rebuilt the user's stack.

### Lines per package

Each package counted its own owned paths before and after (`find` + `wc -l`). Wave-2 paths overlap wave-1 paths, so a wave-2
"before" is the tree after wave 1. The rows do not add up to one repository total.

| Package | Before -> after | Change | Proposals done | Skipped or changed |
|---|---|---|---|---|
| W1-AREAS | 6,730 -> 5,656 | −1,074 | AR-1...AR-7, INFRA-3, INFRA-11, core:P1, core:P11 | AR-6: `sendJsonText` kept (3 lines). Inlining it fails type-checking because the reply is typed by the 200 schema. |
| W1-AUTH | 6,483 -> 5,948 | −535 | A1-A17, core:P11 | None. One fresh-rotation Max-Age assertion kept on purpose (A8). |
| W1-REALTIME | 6,827 -> 6,510 | −317 | RT-1...RT-11, core:P8 | None |
| W1-TILES-RETENTION-META | 4,509 -> 1,592 | −2,917 | tiles:P1 (D-7 proxy deletion), P4, P5, P8, P10 | tiles:P3, P6 and P7 superseded by D-7 (their code was deleted). |
| W1-INFRA | 9,565 -> 8,923 | −642 | INFRA-2, 4, 5, 6, 7, 8, 9, 12, 13, tiles:P9, core:P4(a)(c), core:P11 | `tiles` rate-limit scope and the three `snapland_tile_*` metrics removed (D-7). `GenericRateLimitScope` deleted instead of derived. One in-flight-at-shutdown test kept. |
| W1-CORE | 2,234 -> 1,793 | −441 | INFRA-1 = core:P3, core:P5, P6, P7, P9, P11, A10 (aliases) | The `GOVMAP_*`/`TILE_*` config removal waited for the gate. |
| W1-TOOLING | 4,432 -> 1,324 | −3,108 | T1, T2, T4, T5, T6 (scaffold), T8, T9, T11, T12, T13 (1-4), T14, T16 (1-2) | The permission classifier blocked the T5 root devDependencies, the lockfile refresh and the T12 image HEALTHCHECK. The gate finished all three. |
| W2-SHARED | 5,747 -> 5,330 | −417 | S1, S2, S3, S4 (latitude value unchanged), S5, S6 (a)-(c), S7, S8, S10 | The S3 and S10 tile items no longer applied after D-7. |
| W2-SEAMS | 2,643 -> 2,611 | −32 | core:P4(b), core:P10 (a)-(e), core:P11, core:P12, `UNIT_COVERAGE_SET` | core:P10(f) skipped as planned. The gate finished core:P12 (`migrationsHash` un-exported). |
| W2-BENCH | 462 -> 1,741 | +1,279 (new deliverables) | core:P2 (seed), T6 (k6 script and measured results), T9 (seed service) | None |
| W2-DOCS | 5,012 -> 2,560 | −2,452 | docs-01...08, 10, 11 | docs-09 deferred (the redesign has not been confirmed finished). docs-05 keeps short section 12.3/section 12.7 pointers. The README documents the six E2E specs, which exist now, instead of marking E2E pending. |
| Gate | - | about −110 in code and config, +7 in the README | the cross-package requests below | see *Deviations* |

Wave 1 alone went from 40,780 to 31,746 lines of backend, test, script and config code (−9,034, −22 %). `docs/SPEC.md` is
1,430 lines (was 4,393).

### Cross-package requests applied at the gate

- **D-7 config.** Removed `TILE_RATE_LIMIT_MAX`, the twelve `GOVMAP_*`/`TILE_*` keys and the "https GovMap outside tests" rule from
  `backend/src/config/env.ts`, `env.test.ts` and `.env.example`, all in one change. `TILE_RATE_LIMIT_MAX` was also dropped from
  `docker-compose.e2e.yml`. The SPEC D-7 row and section 11.3 no longer call these keys dead.
- **Shared contracts.** `areas-query.service.ts` now imports `AreaVersionsQuery` from `@snapland/shared`, and its local alias is
  deleted. `ServiceUnavailableError` lost its redundant `code` parameter, and its three call sites and the test were updated. The
  shared barrel comment now points to the `exports` field, not to the deleted lint rule.
- **Test seams.** `migrationsHash` is un-exported. The realtime, auth and foundation suites now call `createSession`,
  `revokeSessionInDb` and `disableUserInDb` from `test/helpers/users.ts` directly. This removed the harness re-export, the kit
  wrappers `revokeInDatabaseOnly`/`disableInDatabase`, and the private revoke/disable SQL copies in `directory.int` and
  `require-role.int`.
- **Tooling.**
  - The root devDependencies `tsx` and `@vitest/coverage-v8` are removed. Nothing at the root uses them, and each workspace
    declares its own.
  - `package-lock.json` is refreshed and no longer lists the `loadtest` workspace.
  - T12: the backend image HEALTHCHECK is removed, together with its `PORT` ENV and the two `healthcheck: disable: true`
    blocks. Compose still probes `/health/ready` on the replicas.
- **Docs.**
  - SPEC S7 and S8 now point to `docs/BENCHMARKS.md` and `docs/benchmarks/*.txt`.
  - The W2-SHARED and W2-SEAMS SPEC follow-ups are applied: the critical-lane type location, `COMMITTED_DECIMALS`, no per-ring
    transport cap, and a synchronous `createContainer` with four overrides.
  - The README load-test commands now use the throwaway `snapland-bench` project and quote the measured default-run numbers.
  - Two stale tutorial statements are fixed: the missing seed script and the `cli` service.

### Deviations and decisions at the gate

- **E2E spec fix.** `e2e/tests/two-users-realtime.spec.ts` read the remote chip's `data-km2` once, at the moment the chip first
  appeared, which is after Alma's first point. It failed twice against the rebuilt stack, although the failure screenshot shows
  Bento seeing the three-point draft at 0.067 km², the same value as Alma's HUD. The read is now an `expect.poll`. Two further runs
  passed.
- **Orphan container.** `docker compose up -d --build --remove-orphans` removed the exited `wait-for-postgres` container. T8
  deleted that service.
- **Lockfile.** npm left the old `loadtest` workspace in the lockfile as an `extraneous` entry, so it was deleted by hand and
  `npm install --package-lock-only` then confirmed the file. npm also added `"peer": true` flags to the optional
  `@esbuild/*`/`fsevents` entries. This is harmless, because no install uses `--omit=peer`.
- **Stale build output.** `backend/dist` and `packages/shared/dist` were cleaned and rebuilt. `tsc` had left the deleted tiles
  module in them.

### Verification (all on the final tree)

| Command | Result |
|---|---|
| `npm run verify` | exit 0: lint 0 warnings, Prettier clean, type-check of every workspace and `scripts`, unit tests with coverage thresholds (shared 125 tests at 99.58 % lines, backend 374 tests at 96.17 %, frontend 526 tests at 96.77 %, scripts 25 tests), `check:deps` clean |
| `node scripts/check-publishable.mjs` | exit 0 |
| `npm run test:integration` | 49 files, 379 tests passed |
| `npm run test:coverage:all -w @snapland/backend` | 96 files, 753 tests; lines 96.67 %, branches 89.41 % (gate 80 / 70) |
| `npm run build` | exit 0 |
| `npm run openapi:export` to a scratch file, then `cmp` with `docs/openapi.json` | identical |
| `docker compose up -d --build --remove-orphans` | every default service healthy; `migrate` exited 0 ("No migrations to run") |
| `curl` through nginx on :5173 | `/` and `/signin` 200; `/health/ready` ok on backend-1 and backend-2; `/docs` 200; `/api/v1/tiles/…` 404 (D-7) |
| Playwright on :5173 (`two-users-realtime`, `layer-switch`) | both pass: sign-in, one user draws and the other sees the live draft, chip, presence and saved area; Map <-> Aerial mid-draw |

The Playwright runs registered a few `e2e-*` users and saved a few test areas in the Negev, in the user's dev database.

### Still open (follow-ups)

- **T3.** Delete `scripts/typecheck-paths.mjs` and `scripts/lib/{cli,process,test-support}.mjs` with their tests. This was kept
  because the frontend follow-up may again run parallel packages that rely on the scoped type-check.
- **Frontend follow-up.** docs-09, S6(d)(e), S9 and T16(4), as section 9 lists them. Also:
  - drop the proxy branch and then `/config` `tiles.govmap`;
  - the stale `GOVMAP_DISABLED`/`CIRCUIT_OPEN` wording in `frontend/src/lib/writeRetry{,.test}.ts`;
  - the `GOVMAP_TILES_ENABLED` mentions in `docs/design/UX.md` (section 0, section 7, UX-AC-103).
- **Tutorial.** `docs/tutorial/` was written against the code before the simplification. Many of its `path:line` citations and
  mentions of deleted files (the tiles proxy, `resilient.ts`, `smoke`) are stale. Regenerate it, or label it as a snapshot.
- **Optional.** Register the shared zod schemas as OpenAPI components; `docs/openapi.json` is 24k lines because every route
  inlines its schemas. A recorded live probe of the L6-L8 ITM tile URLs (SPEC section 8.3) is still pending.
- **Dependencies.** npm reports `prom-client@15.1.3` as deprecated in favour of `@prometheus-io/client`. Nothing breaks.

## Final-QA follow-ups (2026-09-29)

Applied:

- **D-7 frontend follow-up.** The SPA's proxy branch is gone: the Esri + GovMap 2025 `aerial` group, `govmapFallback.ts`, the
  fallback notice, the "Aerial 2022" option with its phone menu, the labels pane and the `/config` `tiles.govmap` reader. *Aerial*
  is the 2022 ITM cache; `VITE_ENABLE_ITM_LAYER=false` still switches it to Esri World Imagery (`aerial`). The backend no longer
  sends `tiles` in `/api/v1/config`, and `ConfigResponseSchema` no longer declares it. UX.md, UI.md and SPEC.md follow.
- **S9.** The protocol examples moved to `packages/shared/src/testing/protocol-examples.ts`, exported only to tests as
  `@snapland/shared/testing`.
- **Clarity.** `LIMITS.usernameMaxLength` bounds the login username. Test-only getters are gone from production classes
  (`RedisAreaQueryCache.l1Size`/`epochBumpPending`, the audit coalescer's and request tracker's `size`, `BaseLayerCrossfade.present`
  and `transitioning`, the throttle's `hasPending`); their tests now observe behaviour and metrics. Dead getters
  (`AreasLayer.size`, `DraftSession.sharingStatus`) are removed.
- **T3.** `scripts/typecheck-paths.mjs` and `scripts/lib/{cli,process,test-support}.mjs` are deleted with their tests.
- **Test order.** `change-feed.int` no longer assumes the first new `change_seq` is `since + 1`: files that ran earlier in the
  run may have consumed sequence values and deleted those rows. It still asserts 50 consecutive seqs, with no gap.

### Deferred for the product owner

These are design-level simplifications. Each works and is tested today; removing it changes behaviour, so it needs a decision.

1. **Soft edit locks** (`realtime/locks.ts`, `lock-store.ts`, `lock.*` messages, handshake snapshot, per-connection cap).
   - Pro: removes about 320 backend lines plus the frontend lock UI; optimistic concurrency with field merge already resolves conflicts.
   - Con: users lose the "someone is editing this" warning before a conflict, and the protocol, handshake and UI all change.
2. **Live-draft lifecycle** (resume across sessions and instances, takeover detection, local-only fallback, keyframes).
   - Pro: keeping only coalescing and idle expiry (enough for R7 and R30) removes about 450 lines and the Redis Lua registry.
   - Con: after a reconnect, others briefly see the draft end and a new one start, and a second tab can no longer take a draft over.
3. **Audit writer retries** (transient-error classification, exponential backoff, row-by-row poison isolation, shutdown budget).
   - Pro: "log the error and drop the batch" (the info log line already records every event) cuts about 200 lines.
   - Con: a short database outage then loses audit rows from the table, and one bad row drops its whole batch.
4. **The 75 environment keys** (WS, realtime, cache, retention and audit tuning knobs mirrored in `.env.example`).
   - Pro: turning pure tuning values into named constants shrinks `env.ts` and `.env.example` by about half.
   - Con: operators lose runtime tuning, and the integration tests that shorten timings need another override path.
5. **Bbox cache design** (in-process L1, gzip L2, per-tile generations on several levels, random epoch, reconnect bumps).
   - Pro: one Redis body cache keyed by a single global generation that every write INCRs would still meet R10 in far fewer lines.
   - Con: every write then invalidates every cached page, so the hit rate drops under steady editing.
