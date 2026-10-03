# Snapland

A real-time collaborative GIS app. Several users draw polygons on the same Leaflet map, see each other's
drawings and presence live, and get the area of every polygon in km², measured geodesically on the WGS84
ellipsoid. The base map switches between **OpenStreetMap** and **GovMap aerial imagery** (תצלום אוויר).

The stack is Node 22 + TypeScript (Fastify, raw WebSocket), PostgreSQL 17 + PostGIS 3.5, Redis 7, React + Leaflet,
nginx, and docker compose.

- **Demo video**: [`docs/demo/snapland-demo.mp4`](docs/demo/snapland-demo.mp4) (2:43, no audio): two users drawing,
  switching to aerial mid-drawing, resolving a conflict, restoring history and surviving a dropped connection.
  Scene list and captions: [`docs/demo/README.md`](docs/demo/README.md).
- **Tutorial**: [`docs/tutorial/index.html`](docs/tutorial/index.html), a ten-chapter course on how the app was
  designed and built. Open the file in a browser; it works offline.

---

## Run it with Docker (recommended)

**Prerequisites:** [Docker Desktop](https://www.docker.com/products/docker-desktop/) running, plus
[Node.js 22.13+](https://nodejs.org/). Node is only used to generate the local `.env` file. Git Bash, PowerShell,
macOS and Linux terminals all work.

```bash
git clone https://github.com/moshepeled/maps.git
cd maps
node scripts/setup-env.mjs              # creates .env from .env.example with a random JWT secret (safe to re-run)
docker compose up -d --build            # builds the images and starts the whole stack in the background
```

Then open **http://localhost:5173**.

- The first build takes a few minutes: it installs dependencies and builds the frontend and backend images.
- Later starts take seconds.
- **Database setup is automatic**: compose starts PostGIS, the one-shot `migrate` service applies every migration in
  `backend/migrations/`, and only then do the backends start. Data lives in the `pgdata` volume.

| URL                                | What it is                               |
| ---------------------------------- | ---------------------------------------- |
| http://localhost:5173              | The app. Sign up, then draw.             |
| http://localhost:5173/docs         | API documentation (OpenAPI / Swagger UI) |
| http://localhost:5173/health/ready | Readiness check (database + Redis)       |

**See real-time collaboration:** open the app in two different browsers, or one normal and one incognito window.
Sign up as two different users and draw in one window. The other window shows the drawing live, and the saved
area appears with the same km².

### Everyday Docker commands

```bash
docker compose ps                                   # is everything "healthy"?
docker compose logs -f nginx backend-1 backend-2    # follow the app logs (Ctrl+C to stop following)
docker compose up -d --build                        # rebuild and restart after pulling new code
docker compose down                                 # stop everything (keeps your data)
docker compose down -v                              # stop everything AND delete the database volume (fresh start)
```

What starts:

| Service                  | Role                                                                           | Host port                     |
| ------------------------ | ------------------------------------------------------------------------------ | ----------------------------- |
| `nginx`                  | serves the built frontend; proxies `/api`, `/ws`, `/docs`, `/health`           | **5173**                      |
| `backend-1`, `backend-2` | two API + WebSocket replicas; realtime fan-out between them goes through Redis | none (internal)               |
| `migrate`                | one-shot job: applies database migrations, then exits                          | none                          |
| `postgres`               | PostgreSQL 17 + PostGIS 3.5                                                    | 55432 (localhost only)        |
| `redis`, `redis-cache`   | pub/sub, presence, rate limits, sessions / bbox cache                          | 56379, 56380 (localhost only) |

Optional extras:

```bash
docker compose --profile tools run --rm seed --count 15000 --region-count 12000 --seed 42   # demo/benchmark polygons
docker compose exec backend-1 node dist/scripts/user-admin.js grant-admin --username alice  # make a user admin
```

---

## Run it in development mode (hot reload)

Use this when you work on the code. The databases run in Docker. The backend and frontend run on your machine with
live reload.

```bash
npm ci                                              # install all workspaces
node scripts/setup-env.mjs                          # create .env (once)
docker compose up -d postgres redis redis-cache     # databases only
npm run migrate -w @snapland/backend -- up          # apply migrations

# then, in two separate terminals:
npm run dev -w @snapland/backend                    # API + WebSocket on http://localhost:3100
npm run dev -w @snapland/frontend                   # app on http://localhost:5174 (proxies /api and /ws to :3100)
```

In dev mode, open **http://localhost:5174**. Port 5173 is reserved for the Docker stack, so both can run at the same
time. Make a registered user admin with `npm run user-admin -w @snapland/backend -- grant-admin --username alice`.

---

## Architecture and technical decisions

- **Commands over REST, events over WebSocket.** Every durable change (create, update, delete, restore) is one
  validated REST call; a custom WebSocket protocol (`snapland.v1`, no collaboration library) carries committed-change
  events, live drafts, presence and advisory edit locks. The app keeps working, and saving, without WebSocket.
- **Stateless replicas.** Two backends behind nginx share PostgreSQL (durable state) and Redis (pub/sub fan-out, rate
  limits, presence, locks, one-time WebSocket tickets); a second Redis holds only the disposable response cache.
- **PostGIS is the source of truth for geometry and area.** Polygons are stored in WGS84, and the km² is computed on
  the ellipsoid by PostGIS at write time; the browser previews it with the same algorithm (geographiclib) while you
  draw.
- **Every version is kept.** Each change appends an immutable snapshot and takes a gap-free change sequence, which
  drives edit history, conflict merges and reconnect-resync.
- **One contracts package.** `packages/shared` holds the zod schemas (REST, WebSocket, OpenAPI), the polygon validator
  and the geodesy, so client and server agree by construction.
- **Aerial is a real projection switch.** _Aerial_ shows GovMap's 2022 orthophoto cache in Israel TM Grid
  (EPSG:2039), so Map <-> Aerial reprojects the map while every drawing stays in WGS84 lat/lng.

The decisions and their trade-offs are recorded as ADRs: [monorepo](docs/adr/0001-monorepo-with-shared-contracts.md),
[Fastify + Zod](docs/adr/0002-fastify-and-zod-single-schema-language.md),
[PostGIS storage model](docs/adr/0003-postgis-storage-model.md) (and why PostgreSQL + PostGIS),
[REST commands / WS events](docs/adr/0004-realtime-commands-over-rest-events-over-websocket.md),
[concurrency and merge](docs/adr/0005-optimistic-concurrency-with-field-merge.md),
[auth and WS tickets](docs/adr/0006-auth-jwt-rotating-refresh-and-ws-tickets.md),
[rate limiting](docs/adr/0008-rate-limiting-drawing-actions.md), [GovMap aerial](docs/adr/0009-default-aerial-govmap-itm-cache.md)
and the [Studio redesign](docs/adr/0010-studio-redesign.md). Diagrams, contracts and the schema are in
[`docs/SPEC.md`](docs/SPEC.md) (section 2 architecture, section 5 database, section 6 REST, section 7 WebSocket).

---

## Performance and optimization

- **Spatial queries**: a partial GiST index on live polygons serves every bounds query; a migration test seeds 12,000
  polygons in one region and asserts the plans use it.
- **10,000+ polygons per region**: per-zoom level of detail (simplification and coordinate precision), culling of
  polygons smaller than 2 px (always reported as "N small areas hidden", never silent), keyset pagination (2,000 per
  page), a per-page budget of 150,000 stored positions (~ 3.6 MB) and a cap on the requested span per zoom.
- **Caching**: bounds query results are cached in-process and, gzip-compressed, in a separate LRU Redis, keyed by
  per-tile generation counters that every write bumps (a random epoch makes a Redis restart safe); ETags give 304s and
  nginx gzips JSON.
- **WebSocket**: viewport interest filtering, latest-wins coalescing, batching, coordinate quantization, a token
  bucket per connection and a two-lane outbound queue that closes slow consumers instead of dropping committed changes.
- **Database**: a pool of 20 connections per replica, prepared statements, statement timeouts, a BRIN index for audit
  time ranges, and batched audit inserts off the request path.
- **Browser**: a canvas renderer, diffs keyed by id + version, and eviction beyond 30,000 areas.

**Benchmarks and load testing**: [`docs/BENCHMARKS.md`](docs/BENCHMARKS.md) has the machine, dataset, commands and
measured numbers. At the default load (3 viewports/s + 1 create/s over 15,000 seeded polygons, about 10.8 bounds pages/s)
page latency was p50 / p95 / p99 = 102.5 / 151.1 / 179.1 ms and create p95 was 60.5 ms, with no failed request. The
load test is one plain k6 script, [`loadtest/bbox.js`](loadtest/bbox.js): bounds reads over the seeded region, writes
kept under the drawing limit, and one burst that must hit it. `BBOX_RATE` / `WRITE_RATE` set the load; logging in the
bench users takes about 60 s because the per-IP auth limit is not raised. Run it on a throwaway project so your own
data stays clean:

```bash
export HTTP_HOST_PORT=25173 PG_HOST_PORT=25432 REDIS_HOST_PORT=26379 REDIS_CACHE_HOST_PORT=26380
docker compose -p snapland-bench up -d --build --wait backend-1 backend-2 nginx
docker compose -p snapland-bench --profile tools run --rm seed --count 15000 --region-count 12000 --seed 42
docker run --rm -i --network snapland-bench_default -e BASE_URL=http://nginx grafana/k6:2.3.0 run -q - < loadtest/bbox.js
docker compose -p snapland-bench down -v
```

Load-testing considerations: no scenario may be bounded by a limiter it is not testing (every result reports its 429
count), the writers stay under 50 drawing actions per minute each, and runs use a throwaway compose project so the
real stack's data stays clean.

---

## Security measures

- **Passwords** are argon2id; unknown usernames take the same time as wrong passwords.
- **Sessions**: a 15-minute access token kept in memory only, and a rotating refresh token in an `HttpOnly`,
  `SameSite=Strict` cookie with reuse detection (a replayed token revokes the session). Logout and revocation apply at
  once; sessions can be listed and revoked.
- **WebSocket**: one-time 30-second tickets (never a bearer token in a URL), Origin and subprotocol checks before the
  upgrade, per-IP upgrade limits, and periodic re-validation that closes sockets of revoked sessions.
- **Abuse limits**: 50 drawing actions per minute per user across REST, WebSocket and both replicas; per-user and
  per-IP API limits; login lockouts per (username, IP) and per username.
- **Input and output**: zod validation at every boundary, text sanitization (control and bidi characters), a strict
  polygon validator backed by PostGIS checks, parameterized SQL only, and output encoding: user text never reaches an
  HTML sink (lint-enforced), with a strict Content Security Policy as defence in depth.
- **HTTP**: an exact-origin CORS allowlist, security headers, request timeouts, a 256 KiB body limit, and error
  responses that never reveal internals.
- **Accountability**: an audit trail of every state-changing request and security event, whatever its outcome.
- **Runtime**: secrets only from validated env (production refuses the example JWT secret), non-root read-only
  containers, and only nginx exposed, on localhost.

Details: [`docs/SPEC.md` section 10.7](docs/SPEC.md) and [ADR-0006](docs/adr/0006-auth-jwt-rotating-refresh-and-ws-tickets.md).

---

## Known limitations

- Concurrent edits of the same polygon's shape conflict (the second editor chooses) instead of merging vertex by vertex.
- Redis pub/sub is at-most-once: an event lost in a crash is repaired by the reconnect resync or the 60-second
  background poll, not instantly.
- The change feed is global and serialized by one lock: hundreds of commits per second at most, and above ~83
  sustained commits per second clients fall back to reloading their viewport.
- During a Redis outage the drawing limit becomes per replica (50 x replicas) and draft ownership is checked locally.
- Presence is broadcast to everyone (capped at 500 entries); users on the REST fallback do not appear in it.
- Polygons crossing the antimeridian and MultiPolygons are rejected; validity uses straight lng/lat edges while area
  is geodesic (negligible within the 20° size limit).
- At low zoom tiny polygons are hidden (and counted) rather than aggregated; beyond 20,000 polygons per viewport the
  map stops loading and says so.
- Aerial imagery is GovMap's undocumented 2022 cache: Israel only, native detail to about 0.33 m per pixel.
- Collaborative permissions are flat (anyone may edit any area); session management and admin tasks are API/CLI only.
- A distributed attacker can lock a known username out of login for 15 minutes.
- One PostgreSQL primary and one Redis; the local stack is plain HTTP; no metrics dashboards or tracing are shipped
  (each replica exposes Prometheus metrics internally).

**GovMap imagery terms:** GovMap's terms require written approval from the Survey of Israel (המרכז למיפוי ישראל,
gis@mapi.gov.il) for non-personal or commercial use, including linking to its tile servers. This assessment build loads
the public 2022 tiles directly in the browser, without faking GovMap's Referer, always shows the attribution and
prefetches nothing. A public deployment needs that approval first, or can build with `VITE_ENABLE_ITM_LAYER=false`
(Esri imagery instead), or embed GovMap's official JS API. See [ADR-0009](docs/adr/0009-default-aerial-govmap-itm-cache.md).

---

## Future improvements and scaling

**Scaling path** (the replicas are stateless, so most steps are configuration): more replicas behind the load
balancer; PgBouncer once replicas x pool size exceeds PostgreSQL's connection limit; read replicas for bounds queries
(writes and the change feed stay on the primary); pub/sub sharded by map region, or Redis Streams / NATS for durable
fan-out; monthly partitions for the audit log; a CDN for the frontend; Redis Sentinel or Cluster for high availability.

**Improvements**: a transactional outbox so no event can be lost between commit and publish; region-sharded change
feeds; vertex-level merging of concurrent shape edits; server-side clustering or vector tiles for very dense views;
a Prometheus + Grafana stack with alerts and OpenTelemetry tracing; TLS at the edge; projects with roles and ACLs; an
account page with active sessions; an offline outbox for edits; an official GovMap imagery agreement.

---

## Testing approach

| Level       | What it covers                                                                                | Where                              |
| ----------- | --------------------------------------------------------------------------------------------- | ---------------------------------- |
| Static      | strict TypeScript, ESLint with zero warnings, Prettier, banned collaboration plugins          | `npm run verify`                   |
| Unit        | pure logic (validation, geodesy, merge, LOD, queues, reducers) with coverage gates; no Docker | colocated `*.test.ts(x)`           |
| Integration | routes, SQL, Lua, pub/sub and the WebSocket protocol against real PostGIS and Redis           | `backend/test/integration/**`      |
| End-to-end  | two browser users on different replicas: live drawing, layer switching, degradation, XSS      | `e2e/tests/*.spec.ts` (Playwright) |
| Load        | bounds reads and writes through nginx, including the 429 of the drawing limit                 | `loadtest/bbox.js` (k6)            |

Integration tests give every run its own database and Redis key prefix, simulate outages with per-test TCP proxies
(never by stopping shared services), and run two app instances in one process to prove cross-replica behaviour. The
area math is checked against reference fixtures to 1e-6, and client/server parity to 1e-9.

```bash
npm run verify              # lint + format + typecheck (incl. `tsc -p scripts`) + unit tests with coverage + banned deps
npm run test:integration    # backend integration tests (needs: docker compose up -d postgres redis redis-cache)
npm run test:e2e            # Playwright against the E2E stack (below)
```

### End-to-end tests

The end-to-end tests need the E2E variant of the stack: the same services, plus test hooks in the frontend build and
raised sign-in limits (every browser context shares one IP). Start it before `npm run test:e2e`, and switch back
afterwards:

```bash
cd e2e && npx playwright install chromium && cd ..                             # once: the browser Playwright drives
docker compose -f docker-compose.yml -f docker-compose.e2e.yml up -d --build   # E2E stack on http://localhost:5173
npm run test:e2e                                                               # 15 tests; HTML report in e2e/playwright-report/
docker compose up -d --build                                                   # back to the normal stack
```

The specs (`e2e/tests/`: `studio-frame`, `ux-touch`, `two-users-realtime`, `layer-switch`, `degradation`, `xss`)
assert only the DOM contract, so they also run against a production build: set `E2E_BASE_URL` to point them at another
stack, for example an isolated copy on another port (`E2E_BASE_URL=http://localhost:5185 npm run e2e -w @snapland/e2e`).
Every run registers its own users and areas (password: `SEED_USER_PASSWORD` from `.env.example`, or `E2E_PASSWORD`), so
do not point them at a stack whose data you want to keep clean. Every command is listed in
[`docs/SPEC.md` section 12.1](docs/SPEC.md).

---

## Troubleshooting

| Symptom                                                                                                                                 | Fix                                                                                                                                                                                                                                                            |
| --------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **"This site can't be reached" on :5173**                                                                                               | Run `docker compose ps`. `nginx` must be listed and `healthy`. If it is missing or not healthy, `docker compose up -d --build` failed: scroll up in its output, or run `docker compose ps -a` and `docker compose logs migrate backend-1 nginx`.               |
| `docker compose` says Docker is not running                                                                                             | Start Docker Desktop and wait until it says "Engine running".                                                                                                                                                                                                  |
| Port 5173 / 55432 / 56379 already in use                                                                                                | Change `HTTP_HOST_PORT`, `PG_HOST_PORT` or `REDIS_HOST_PORT` in `.env`, then run `docker compose up -d` again.                                                                                                                                                 |
| `backend-1` keeps restarting                                                                                                            | Run `docker compose logs backend-1`. Usually `.env` is missing or old: run `node scripts/setup-env.mjs`. It never overwrites an existing `.env`, so compare it with `.env.example`.                                                                            |
| Host tools (tests, `npm run migrate`) fail with `Connection terminated unexpectedly` while `docker compose ps` shows everything healthy | Docker Desktop's port forwarding can go stale after containers are recreated. Run `docker compose restart postgres redis redis-cache`. Compose then restarts `backend-1` and `backend-2` as well, so they reconnect to the right containers. The data is kept. |
| http://localhost:5173 suddenly resets or hangs while `docker compose ps` shows `nginx` healthy                                          | Same Docker Desktop port-forwarding hiccup on the published port. Run `docker compose restart nginx`.                                                                                                                                                          |
| Want a completely fresh database                                                                                                        | `docker compose down -v && docker compose up -d --build`                                                                                                                                                                                                       |

---

## Project layout

```
backend/          Fastify API + WebSocket gateway (modules: auth, areas, realtime, admin, retention, …) and SQL migrations
frontend/         React + Leaflet app (map, custom polygon drawing, realtime client, presence)
packages/shared/  contracts shared by both: zod schemas, WebSocket protocol, polygon validation, geodesic area
e2e/              Playwright end-to-end tests
loadtest/         k6 load test (bbox.js)
docker/           nginx image and PostgreSQL init script
scripts/          repo tooling (setup-env, banned-dependency and publishability checks)
docs/             SPEC.md (design reference), adr/, openapi.json, BENCHMARKS.md, design/ (UX/UI specs, mockups),
                  tutorial/ (the course), demo/ (the demo video)
```

## Documentation

- [`docs/SPEC.md`](docs/SPEC.md): architecture, database schema, REST and WebSocket contracts, security, scaling and
  test strategy.
- [`docs/adr/`](docs/adr/): architecture decision records (linked above).
- [`docs/openapi.json`](docs/openapi.json): the OpenAPI 3.1 document, also served live at `/docs`
  (regenerate with `npm run openapi:export -w @snapland/backend`).
- [`docs/BENCHMARKS.md`](docs/BENCHMARKS.md): performance measurements and load-test results.
- [End-to-end tests](#end-to-end-tests): how to run the Playwright suite (above, under Testing approach).
- [`docs/tutorial/index.html`](docs/tutorial/index.html): the ten-chapter tutorial on how Snapland was built.
- [`docs/demo/snapland-demo.mp4`](docs/demo/snapland-demo.mp4): the demo video ([scene list](docs/demo/README.md)).
- [`docs/design/UX.md`](docs/design/UX.md) and [`docs/design/UI.md`](docs/design/UI.md): interaction and visual design.
- [`instractions.md`](instractions.md): the original assignment.
# maps
