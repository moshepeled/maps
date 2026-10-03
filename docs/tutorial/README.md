# Snapland tutorial - How this app was designed and built

A ten-chapter course that explains, end to end, how Snapland was designed and built: the assignment and the
product, the system design, PostgreSQL and PostGIS, the Fastify backend and its security, the areas write path,
the WebSocket layer on both sides, the React and Leaflet frontend, Docker and nginx, and the tests that prove it.
It is written for someone who knows JavaScript, TypeScript, React and SQL but is new to PostGIS, WebSockets,
Docker and nginx. Every chapter starts with the problem it solves, uses the real code of this repository (paths
and line numbers included), has a diagram per concept that needs one, and ends with "Try it yourself" exercises
against the running app plus a five-question self-check with answers.

## How to open the tutorial

Open **`docs/tutorial/index.html`** in any browser: double-click it in a file manager, or from the repository
root run `start docs/tutorial/index.html` (Windows), `open docs/tutorial/index.html` (macOS) or
`xdg-open docs/tutorial/index.html` (Linux).

- It is one self-contained page: the styles and all 50 diagrams are embedded, and it needs no network access.
- The four screenshots in Chapter 1 are loaded from `docs/design/concepts/1-studio/` and `docs/benchmarks/`,
  so keep `index.html` where it is inside the repository.
- On a wide screen the chapter list stays in a left sidebar and follows your reading position; on a phone it
  folds into a "Contents" block at the top.
- The exercises need the running app. From the repository root: `node scripts/setup-env.mjs`, then
  `docker compose up -d --build`, then open http://localhost:5173 (see the root `README.md`).

`preview.png` is a 1280x900 render of the page.

## Chapters

| # | Chapter | Source |
|---|---|---|
| 1 | What we are building and why | [`chapters/01-what-we-are-building.md`](chapters/01-what-we-are-building.md) |
| 2 | Designing the system: from requirements to architecture | [`chapters/02-system-design.md`](chapters/02-system-design.md) |
| 3 | The database: PostgreSQL, PostGIS and geodesy | [`chapters/03-database-and-postgis.md`](chapters/03-database-and-postgis.md) |
| 4 | The backend: Fastify foundation, security and authentication | [`chapters/04-backend-foundation-and-auth.md`](chapters/04-backend-foundation-and-auth.md) |
| 5 | Areas: validation, versioning, conflicts and caching | [`chapters/05-areas-conflicts-caching.md`](chapters/05-areas-conflicts-caching.md) |
| 6 | Real-time: the WebSocket gateway and cross-instance fan-out | [`chapters/06-realtime-server.md`](chapters/06-realtime-server.md) |
| 7 | The frontend: React, Leaflet, custom drawing and projections | [`chapters/07-frontend-map-and-drawing.md`](chapters/07-frontend-map-and-drawing.md) |
| 8 | The frontend: real-time client, conflicts and resilience | [`chapters/08-frontend-realtime-and-resilience.md`](chapters/08-frontend-realtime-and-resilience.md) |
| 9 | Running it: Docker, nginx, configuration and scaling | [`chapters/09-docker-nginx-and-ops.md`](chapters/09-docker-nginx-and-ops.md) |
| 10 | Testing and quality: how we know it works | [`chapters/10-testing-and-quality.md`](chapters/10-testing-and-quality.md) |

What each chapter covers:

1. **What we are building and why** - the assignment, the product and its three personas, the four goals
   (real-time, accuracy, scalability, security), how to run the stack, and where the code lives.
2. **Designing the system** - requirement traceability, the system model (nginx, two stateless replicas,
   PostgreSQL/PostGIS, Redis), the inside of one backend instance, the shared contracts package, and how the
   build itself was run.
3. **The database** - PostGIS for a SQL person: one stored CRS, geodesic area on the WGS84 ellipsoid, the GiST
   index, validation in depth, immutable version snapshots, and the purge watermark.
4. **The backend foundation and auth** - Fastify from boot to reply: the container, the request pipeline,
   health checks, JWT access tokens, rotating refresh cookies, and the one-time WebSocket ticket.
5. **Areas** - the one write path: validation, rate limits, versioning, optimistic concurrency with three-way
   merge, the change feed, and the bbox cache.
6. **The real-time server** - the WebSocket gateway: the handshake, viewport interest, Redis pub/sub fan-out
   across replicas, the two send lanes, and the liveness clocks.
7. **The frontend map and drawing** - React chrome over Leaflet: stores and pure reducers, the custom drawing
   tool, the workspace mode machine, the cross-CRS switch, and theming.
8. **The frontend real-time client and resilience** - the RealtimeClient state machine, catch-up after a gap,
   remote drafts, conflict resolution, and the limited mode without a socket.
9. **Docker, nginx and ops** - containers, the multi-stage image, the compose topology and its boot gates,
   nginx routing and load balancing, configuration, and graceful shutdown.
10. **Testing and quality** - the test pyramid: shared fixtures, unit and integration tests with private
    databases, Playwright two-user specs, and the verification ladder.

## Layout of this folder

- `index.html` - the whole course as one page.
- `chapters/NN-*.md` - the Markdown source of each chapter, in reading order.
- `diagrams/NN-*-K.svg` - the diagrams, five per chapter, inlined into `index.html`.
- `preview.png` - a 1280x900 render of `index.html`.
