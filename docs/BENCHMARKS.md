# Benchmarks

Measured on 2026-09-29 against a throwaway compose project (`snapland-bench`) built from this repository. Every number
below is copied from the raw outputs in [`docs/benchmarks/`](benchmarks/). Nothing is estimated.

| File | Content |
|---|---|
| [`k6-bbox.txt`](benchmarks/k6-bbox.txt) | k6 summary, default load (3 viewports/s + 1 create/s) |
| [`k6-bbox-rate5.txt`](benchmarks/k6-bbox-rate5.txt) | k6 summary, 5 viewports/s + 1 create/s |
| [`k6-bbox-saturation.txt`](benchmarks/k6-bbox-saturation.txt) | k6 summary, 8 viewports/s + 2 creates/s |
| [`docker-stats.txt`](benchmarks/docker-stats.txt) | `docker stats` every ~10 s during the load phase of each run |
| [`explain-migrations.txt`](benchmarks/explain-migrations.txt) | output of the EXPLAIN acceptance test |

## 1. Environment

| | |
|---|---|
| Machine | Intel Core i7-12700 (12 cores, 20 threads), 31.7 GB RAM |
| OS | Windows 11 Pro 10.0.26200 |
| Docker | Docker Desktop, engine 29.8.0, Compose v5.5.1, WSL2 kernel 5.15.153.1; 20 CPUs and 15.47 GiB available to Docker |
| Compose limits | `backend-1`, `backend-2`: 1 CPU and 512 MiB each. `nginx`: 1 CPU and 256 MiB. `postgres`, `redis`, `redis-cache`: no CPU limit |
| PostgreSQL | `postgis/postgis:17-3.5-alpine`: `shared_buffers=256MB`, `work_mem=16MB`, `max_connections=100`, `jit=off` |
| Redis | `redis` 512 MB `noeviction`; `redis-cache` 256 MB `allkeys-lru` |
| App config | `.env`, with the `.env.example` values: `DB_POOL_MAX=20` per replica, `API_RATE_LIMIT_MAX=300`/min per user, `AUTH_RATE_LIMIT_MAX=10`/min per IP, `DRAW_RATE_LIMIT_MAX=50` per 60 s per user, `CACHE_BBOX_TTL_S=120`, `CACHE_L1_TTL_MS=30000`, `CACHE_L2_MAX_BODY_BYTES=524288` |
| Load generator | `grafana/k6:2.3.0` in a container on the same host and compose network. It reaches nginx at `http://nginx`. |

The host also ran other, idle containers (the default `snapland` dev stack and two unrelated projects). k6 shares the
host CPUs with the stack it measures.

## 2. Dataset

`backend/src/scripts/seed.ts` writes every area through the production statements (`AREAS_SQL.insert` +
`AREAS_SQL.insertVersionFromCurrent`, under the change-feed lock). Measurements, version 1 and `change_seq` are
therefore exactly what `POST /api/v1/areas` writes.

- 12,000 polygons lie inside the Tel Aviv region `[34.70, 31.95, 34.95, 32.20]`. This is the region of the EXPLAIN test.
- 3,000 polygons lie in southern Israel `[34.3, 29.6, 35.4, 31.8]`, which does not overlap the region.
- Each polygon is star-shaped with 5-40 vertices. Its radius is log-uniform in 15 m-800 m in the region and 30 m-3 km
  elsewhere.
- Every shape passes the server's validation (`validateGeometryInput`, stages 1-12) before it is inserted.
- 50 users `bench-001` ... `bench-050` share the password `SEED_USER_PASSWORD`.

Seed output (first run, then a second run to prove idempotency; about 25 s wall clock for the first run):

```text
{"users":{"total":50,"created":50},"areas":{"total":15000,"region":12000,"inserted":15000},"seed":42}
{"users":{"total":50,"created":0},"areas":{"total":15000,"region":12000,"inserted":0},"seed":42}
```

Row counts after both runs:

```text
 areas | in_region | versions | bench_users | min_vertices | max_vertices | avg_vertices | areas_size
-------+-----------+----------+-------------+--------------+--------------+--------------+------------
 15000 |     12000 |    15000 |          50 |            5 |           40 |         22.4 | 9976 kB
```

`in_region` counts the polygons that `ST_CoveredBy` the region envelope.

## 3. Commands

From the repository root, in Git Bash. The alternate host ports keep the bench project clear of the default stack.

```bash
export HTTP_HOST_PORT=25173 PG_HOST_PORT=25432 REDIS_HOST_PORT=26379 REDIS_CACHE_HOST_PORT=26380
docker compose -p snapland-bench up -d --build --wait backend-1 backend-2 nginx
docker compose -p snapland-bench --profile tools run --rm seed --count 15000 --region-count 12000 --seed 42

# Default load, then the two heavier runs (each on a fresh stack: down -v, up, seed).
docker run --rm -i --network snapland-bench_default -e BASE_URL=http://nginx \
  grafana/k6:2.3.0 run -q - < loadtest/bbox.js | tee docs/benchmarks/k6-bbox.txt
docker run --rm -i --network snapland-bench_default -e BASE_URL=http://nginx -e BBOX_RATE=5 -e WRITE_RATE=1 \
  grafana/k6:2.3.0 run -q - < loadtest/bbox.js | tee docs/benchmarks/k6-bbox-rate5.txt
docker run --rm -i --network snapland-bench_default -e BASE_URL=http://nginx -e BBOX_RATE=8 -e WRITE_RATE=2 \
  grafana/k6:2.3.0 run -q - < loadtest/bbox.js | tee docs/benchmarks/k6-bbox-saturation.txt

# Sampled about every 10 s during each load phase (docs/benchmarks/docker-stats.txt):
docker stats --no-stream --format '{{.Name}} {{.CPUPerc}} {{.MemUsage}}' $(docker ps -q --filter name=snapland-bench)

docker compose -p snapland-bench down -v

# EXPLAIN evidence (needs the dev postgres/redis services: docker compose up -d postgres redis redis-cache).
cd backend && npx vitest run -c vitest.integration.config.ts migrations --maxWorkers=2
```

## 4. The load test

[`loadtest/bbox.js`](../loadtest/bbox.js) is one plain k6 script with three scenarios. Each load phase lasts 2 minutes.

- **Setup.** The script logs in as `bench-001` ... `bench-020`. The per-IP auth limit (10 logins/min) makes it wait for the
  next window after 10 logins, so setup takes about 60 s. No limit is raised for the test.
- **`bbox`.** `BBOX_RATE` viewports per second. Each viewport is a padded 1920x1080 window (1.5x, like the SPA) centred at
  a random point of the region, at a random zoom from 12 to 16. The script follows `nextCursor` with `limit=2000`, at most
  10 pages, exactly as the SPA does. Viewports are shared round-robin by 16 users, which keeps every user far below the
  300/min `api` limit.
- **`writes`.** `WRITE_RATE` creates per second of a ~50 m square inside the region, shared round-robin by 3 users. That
  is 20/min per user by default and 40/min at `WRITE_RATE=2`, both under the 50/min drawing limit.
- **`burst`.** One more user sends 60 creates back to back. The thresholds require exactly 50 x 201, then 10 x 429 with a
  `Retry-After` header.

k6 computes rates over the whole run, and the whole run includes the ~60 s login setup (about 182 s in all). The
"~ per s" column below is therefore derived as `count / 120 s` (the load phase).

## 5. Results

| Run | Offered load | `GET /api/v1/areas` pages | Page latency p50 / p95 / p99 | Create latency p50 / p95 / p99 | Failed requests | Thresholds |
|---|---|---|---|---|---|---|
| default | 3 viewports/s, 1 create/s | 1,294 (~ 10.8/s) | 102.5 / 151.1 / 179.1 ms | 16.6 / 60.5 / 112.3 ms | 0 of 1,294 pages, 0 of 121 creates | all pass |
| rate5 | 5 viewports/s, 1 create/s | 2,003 (~ 16.7/s) | 103.5 ms / 1.31 s / 2.39 s | 32.5 ms / 1.47 s / 2.73 s | 0 of 2,003 pages, 0 of 121 creates | latency thresholds fail |
| saturation | 8 viewports/s, 2 creates/s | 3,174 (~ 26.5/s) | 1.78 / 2.59 / 3.03 s | 6.08 / 7.38 / 9.05 s | 1 of 3,174 pages, 32 of 187 creates | latency, write errors and burst fail |

| Run | `X-Cache` MISS / HIT-L1 / HIT-L2 / BYPASS | Data received | Dropped iterations | Burst (201 / 429) |
|---|---|---|---|---|
| default | 1,241 / 21 / 31 / 1 | 424 MB | 0 | 50 / 10, each 429 with `Retry-After` |
| rate5 | 1,899 / 58 / 45 / 1 | 655 MB | 7 | 50 / 10 |
| saturation | 3,108 / 55 / 9 / 1 | 1.0 GB | 108 | 57 / 0 (see below) |

CPU during the load phase (`docker stats`, 12 samples per run; 100 % = one core):

| Run | backend-1 avg / max | backend-2 avg / max | nginx avg / max | postgres avg / max |
|---|---|---|---|---|
| default | 43 / 69 % | 46 / 69 % | 36 / 60 % | 37 / 56 % |
| rate5 | 57 / 102 % | 54 / 99 % | 49 / 101 % | 54 / 134 % |
| saturation | 93 / 107 % | 92 / 105 % | 84 / 105 % | 87 / 142 % |

What the numbers show:

- **10,000+ polygons per region.** A zoom-12 viewport covers the whole 12,000-polygon region, so the client loads it in
  several pages of up to 2,000 polygons. In the default run a viewport took 3.6 pages on average (1,294 pages for 360
  viewports at zoom 12-16). These pages came back in 102 ms (p50) and 151 ms (p95), with no errors.
- **Capacity.** Two replicas limited to 1 CPU each sustain about 11 pages/s with p95 ~ 150 ms. 424 MB arrived over the
  wire in the 2-minute load phase (~ 3.5 MB/s). At 5 viewports/s the median is unchanged, but short CPU peaks reach the
  1-CPU limits and the tail grows (p95 1.3 s). At 8 viewports/s both replicas and nginx stay near their CPU limits, and
  every request queues.
- **Where it breaks first: writes.** A create holds the change-feed advisory lock from `nextval` to `COMMIT`. When the
  event loops are saturated, the lock holder's next statement waits behind page serialisation, so the lock is held
  longer and other creates queue for it. In the saturation run, 32 creates failed. In an earlier run at the same rates,
  the backend logs showed these failures as 503 responses: `lockChangeFeed` hit the 5 s statement timeout
  (`canceling statement due to statement timeout`). This is the designed degradation: a bounded wait that ends in a 503,
  never a hung request.
- **The burst under saturation.** Each create took seconds, so the burst's 60 creates spread over more than 60 s (the
  longest iteration of the run took 2 min 5 s). They never reached 50 inside one 60 s window, so the sliding-window
  limiter correctly returned no 429: 57 creates succeeded and 3 failed with neither 201 nor 429. At the default load the
  burst proves the limit exactly: 50 x 201, then 10 x 429.
- **Cache mix.** The hit ratio is low by construction:
  - Each create bumps the cache generation of the tiles it touches, at every cache level.
  - A zoom-12 to zoom-14 key covers most of the region, so a steady stream of creates inside the region invalidates
    nearly every low-zoom page.
  - Random centres at zoom 15-16 rarely repeat a snapped bbox within the TTL.

  This is the worst case for the cache. The cache's correctness and its hit path are proven by
  `test/integration/platform/area-cache.int.test.ts` and `test/integration/system/cross-instance-rest-ws.int.test.ts`.

## 6. Query plans (EXPLAIN)

`backend/test/integration/foundation/migrations.int.test.ts` inserts 12,000 synthetic areas in the Tel Aviv region plus
3,000 elsewhere, runs `ANALYZE`, and then runs `EXPLAIN (ANALYZE, BUFFERS)` on the production `AREAS_SQL.findInBbox`
statement (LOD, culling, position budget, 2,001-row page) with parallel workers off. The run in
[`explain-migrations.txt`](benchmarks/explain-migrations.txt) passed all 12 tests:

- **Zoom 14 (~700x500 px) and zoom 16 (1280x720 px) viewports** use `areas_geom_live_gist`, the partial GiST index on
  live rows, and never a `Seq Scan on areas`. The test asserts both.
- **Zoom 14 (1280x720 px), 9.6 ms, and the zoom-12 whole region, 8.4 ms:** both are well under the asserted 250 ms. When
  the snapped bbox matches more rows than the page limit, the planner walks `areas_pkey` in id order and stops at 2,001
  rows. This is the keyset order the cursor needs, and it is still not a Seq Scan.

## 7. Load-testing considerations

- **What scales horizontally.**
  - The replicas are stateless behind nginx (`least_conn`, no sticky sessions).
  - WebSocket tickets, revocation marks, rate-limit windows, presence, locks, drafts and cache generations live in
    Redis. Users, sessions and areas live in PostgreSQL.
  - The measured bottleneck is replica CPU (serialising 2,000-polygon pages) and then nginx gzip. More replicas, or more
    CPU per replica, raise the read ceiling directly.
  - Beyond that ceiling, the next shared limits are the change-feed lock (one create commits at a time) and PostgreSQL.
- **Per-user rate limit.**
  - The drawing limit is a sliding window of 50 actions per 60 s per user.
  - It lives in Redis, so every replica enforces one shared budget. It falls back to a per-process window if Redis is
    unreachable.
  - The burst proves it through nginx and both replicas. `test/integration/platform/draw-rate-limit.int.test.ts` proves
    the exact semantics.
  - Load tests must respect every limit instead of raising it: the users are spread so that each stays under the
    300/min `api` limit, and logins are paced by the 10/min per-IP auth limit.
- **Pool sizing.**
  - `DB_POOL_MAX=20` per replica gives 40 connections, below `max_connections=100`. The rest is left for `migrate`,
    `seed`, admin sessions and a third replica.
  - Waiting for a connection is bounded by `DB_CONNECTION_TIMEOUT_MS` and ends in 503 `DEPENDENCY_UNAVAILABLE` with
    `Retry-After` (`foundation/db-pool.int.test.ts`). A statement is bounded by `DB_STATEMENT_TIMEOUT_MS` and ends in
    503 `REQUEST_TIMEOUT` (`foundation/timeouts.int.test.ts`). Both are 5 s.
  - PostgreSQL used at most 1.4 cores in the saturation run. The pool was not the limit.
- **Redis roles.**
  - `redis` (`noeviction`) holds the state that must not disappear: limiter windows, WebSocket tickets, revocations,
    presence, locks, drafts, cache generations and pub/sub.
  - `redis-cache` (`allkeys-lru`, 256 MB) holds only L2 page bodies. It filled up and evicted during every run, as
    designed, without touching the critical instance.
- **WebSocket fan-out.** k6 did not measure it here. Cross-instance delivery is covered by integration tests:
  - `test/integration/realtime/cross-instance.int.test.ts`: a bus event on instance A reaches a client on instance B.
  - `test/integration/system/cross-instance-rest-ws.int.test.ts`: a REST create on A reaches a WebSocket client on B
    within 500 ms, and a bbox read on B right after the 201 already contains the new area.
  - `test/integration/realtime/backpressure.int.test.ts`: slow consumers, floods and resync.
- **Not measured.**
  - WebSocket fan-out throughput with hundreds of clients.
  - Browser rendering time.
  - Sustained write throughput above 2 creates/s.
  - A multi-host deployment: here k6, nginx, the replicas and the databases share one machine.
  - Long soak runs.
  - Failover of a replica or of Redis under load.
