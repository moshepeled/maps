# ADR-0005: Optimistic concurrency with field-level merge and advisory soft locks

- Status: Accepted
- Date: 2026-09-27

## Context
Several users may edit the same area at once. We must never lose an update silently. We also should not reject edits that do not
actually collide, such as one user renaming while another reshapes.

## Decision
- **Row lock.** `SELECT ... FOR UPDATE` serializes writers per area.
- **`baseVersion` is required.** Every PATCH/DELETE/restore sends one (428 if missing).
- **Three-way merge per field** (`name`, `description`, `geometry`; geometry is atomic):
  - The base snapshot comes from `area_versions`. The server-changed fields are the union of `changed_fields` since the base.
  - Disjoint changes auto-merge (`merged: true`).
  - Overlapping changes with different values give 409 `VERSION_CONFLICT`, with `current`, `conflictingFields` and
    `currentVersion`.
  - Overlapping changes to the same value converge (no-op).
- **Deletes never merge.** A stale base gets 409. Mutations on tombstones get 409 `AREA_DELETED`.
- **Idempotency.**
  - Creates use client-generated ids; the id is reused from the draft, so the remote ghost becomes the committed area.
  - A PATCH that changes nothing returns `noop: true` without a new version, so network retries are safe.
- **Advisory soft locks** over WS (`lock.acquire`, 30 s TTL, renewed every 10 s) show "Alice is editing". They are not enforced by
  REST, because correctness must not depend on the WebSocket being up.

## Consequences
- No lost updates, and far fewer user-visible conflicts than a strict If-Match scheme.
- The conflict UI must offer the UX C-19 actions *Keep mine*, *Take theirs*, *Review differences* (per-field choice) and
  *Decide later*; editing a deleted area offers the C-20 actions *Restore* (creator/admin), *Save as a new area* and *Discard*.
- Concurrent vertex edits of the same polygon still conflict. Vertex-level OT/CRDT is future work.

## Alternatives considered
- **Last-writer-wins**: loses data silently.
- **Pessimistic (enforced) locks**: break when the WS is down and leave orphaned locks on crashes.
- **CRDT for all fields**: heavy for small metadata. Geometry CRDTs for rings are research-grade and outside scope.
