# ADR-0004: Commands over REST, events over a custom WebSocket protocol, Redis pub/sub fan-out

- Status: Accepted
- Date: 2026-09-27

## Context
Users must see each other's drawing in real time, across several backend instances. The app must keep working when WebSockets fail,
and the assignment forbids third-party collaboration plugins.

## Decision
- **One write path.** Every durable mutation (create/update/delete/restore) is a REST call through the same service. The WebSocket
  (`/ws`, subprotocol `snapland.v1`, raw `ws` via `@fastify/websocket`) carries:
  - committed-change events (`area.changed` with the global `changeSeq`);
  - ephemeral drafts (`draft.updated` at <= 10 Hz, coalesced, with keyframes);
  - presence;
  - advisory soft locks;
  - heartbeats.
- **Interest management.** Each connection declares a viewport; the server only sends spatial events that intersect it (+50% margin).
- **Fan-out.** Redis pub/sub channels (`snap:ch:{areas,drafts,presence,locks,sessions}`). The publishing instance delivers locally
  at once and skips its own messages when they come back.
- **Message queuing / backpressure** per connection:
  - an inbound token bucket;
  - a two-lane outbound queue: critical messages are never dropped, ephemeral ones are latest-wins by key;
  - batching up to 64 KiB, and serializing each message once per instance;
  - slow consumers are closed with 1013 and resync on reconnect.
- **Recovery.** Clients resync from the REST change feed on reconnect and every 60 s (anti-entropy). While offline they poll it every
  5 s ("REST mode").
- **Order-independent client state.** Events from different instances can arrive in any order, so the client applies an
  upsert only when `version > max(knownVersion, tombstoneVersion)` and remembers deletes as tombstones (a late older update can never
  resurrect a deleted area). The feed cursor advances only from change-feed pages, never from bbox pages or WS events, and feed items
  for areas already in the store are always applied, even outside the viewport.
- **Region loading and staleness.** A region being loaded counts as loaded for applying feed items, and every region load
  ends with a catch-up from `min(restCursor, oldest page asOfChangeSeq)`, so an area created between two pages or a stale cached page
  is repaired even without WebSocket.
- **Liveness.** The client pings whenever nothing has been *received* for 20 s (not when its own sends are idle), so a user
  who only streams drafts is never declared dead.
- **Ordering.** The areas service publishes the bus event *before* sending the HTTP response, so a client's following
  `draft.end` can never overtake the `area.changed` it caused; draft coalescer and keyframe timers are cancelled before
  `draft.ended` is published, and receivers ignore updates for recently ended drafts.

## Consequences
- Graceful degradation comes almost for free: without WS the app still reads, writes and (by polling) sees others' changes.
- One validated, documented write path: OpenAPI, rate limits and audit are applied once.
- Latency is slightly higher than writing over WS (one HTTP round trip). This is negligible for saves; drafts, the latency-critical
  part, stay on WS.
- Pub/sub is at-most-once, so loss is repaired by resync. A transactional outbox or Redis Streams is the documented upgrade.
- Instances are stateless and need no sticky sessions (tickets live in Redis); nginx uses `least_conn`.

## Alternatives considered
- **socket.io / Yjs / Liveblocks**: forbidden by the assignment, and they hide the protocol design being evaluated.
- **Writes over WS as well**: duplicates validation/authorization paths and weakens degradation.
- **Kafka/RabbitMQ**: durability we do not need for fan-out (PostgreSQL is the durable log); higher latency and operational cost.
- **Postgres LISTEN/NOTIFY**: transactional, but has an 8 KB payload cap and needs a dedicated connection per instance; kept as a
  future outbox relay option.
