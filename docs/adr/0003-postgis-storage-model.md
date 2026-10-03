# ADR-0003: PostgreSQL 17 + PostGIS 3.5 storage model

- Status: Accepted
- Date: 2026-09-27

## Context
We store user-drawn polygons, query them by map bounds at 10k+ polygons per region, return accurate areas in km² (accounting for
Earth's curvature), keep an edit history, and support soft deletes with retention. The assignment asks for PostgreSQL with PostGIS
or a justified alternative.

## Decision
- **Geometry column**: `geometry(Polygon, 4326)`.
  - WGS84 lng/lat, RFC 7946 winding enforced with `ST_ForcePolygonCCW`, coordinates quantized to 7 decimals.
  - We cast to `geography` for measurement. `area_km2 = ST_Area(geom::geography)/1e6` and `perimeter_km` are computed on the WGS84
    ellipsoid at write time and stored.
- **Indexing**: GiST index `areas_geom_live_gist ... WHERE deleted_at IS NULL`, so bbox queries use the R-tree and skip tombstones.
- **Bbox reads apply LOD**:
  - simplification (`ST_Simplify(geom, tol, true)`: list geometry is display-only, and topology preservation cost 27 ms vs 8 ms for
    a z14 page of 1,001 areas);
  - coordinate precision (`ST_AsGeoJSON(geom, digits)`);
  - sub-pixel culling (`bbox_extent_deg`);
  - keyset pagination on `id`, bounded by a per-page budget of stored positions (150,000) computed in SQL before any GeoJSON is
    generated, and a per-zoom bbox span cap (8,192 px), so one request can never materialise ~91 MB of geometry.
- **Versioning**: `areas` holds current state and a `version`. Each mutation appends a full snapshot to the immutable
  `area_versions` table in the same transaction (a trigger rejects UPDATE).
- **Change feed**: a global sequence `area_change_seq` numbers every committed change. `nextval` runs under a transaction-scoped
  advisory lock, so commit order equals sequence order and the feed has no gaps for readers.
- **Validity**: `CHECK (ST_IsValid(geom))` plus server-side `ST_IsValid` pre-checks back up the shared validator.
- **Audit time index**: BRIN on `audit_logs.occurred_at` with `autosummarize = on`; analytics filter the base table on `occurred_at`
  (a filter on a `date_trunc` view column cannot use any index).
- **Retention**: soft delete via `deleted_at`. A retention job, guarded by `pg_try_advisory_lock`, purges after 30 days (versions
  cascade). A purge watermark makes the change feed answer 410 for cursors that predate a purge.
- **Migrations**: node-pg-migrate 9 with plain SQL files (Up/Down sections) and an advisory lock.

## Consequences
- Area accuracy comes from PostGIS (Karney's algorithm). The fixtures in `docs/fixtures/geodesic-area-fixtures.json` show the
  browser library agrees within ~1e-12.
- Planar GiST on lng/lat is the fastest bbox index. Area/perimeter never use a projection; Web Mercator would overestimate area by
  ~40% in Israel.
- The advisory lock caps commit throughput at hundreds per second. That is ample under a 50/min/user limit, and xid8 snapshot
  horizons are the documented upgrade path.
- Storing full snapshots per version costs space. It keeps history reads and base-version merges trivial.

## Alternatives considered
Why PostgreSQL + PostGIS rather than another store:
- **Correct geodesy in the database**: `ST_Area(geom::geography)` computes the ellipsoidal area on WGS84 with the same algorithm as
  the client library, so no hand-rolled server math has to be trusted.
- **Spatial indexing**: a GiST R-tree answers bbox intersection in O(log n + k), and the partial predicate keeps soft-deleted rows
  out of the hot path.
- **GEOS validity** (`ST_IsValid`, `ST_IsValidReason`) as an authoritative second line behind the shared validator, and DB `CHECK`s
  as the last one; **server-side LOD** (`ST_Simplify`, `ST_AsGeoJSON(geom, digits)`) shrinks payloads per zoom.
- **Transactions and row locks** give optimistic concurrency and an append-only history in one atomic commit; a sequence plus an
  advisory lock gives a gap-free change feed.

Rejected:
- **MongoDB 2dsphere**: spherical area only, no GEOS validity, weaker transactions and joins for the history.
- **SpatiaLite**: single writer, no horizontal-scaling story.
- **Elasticsearch `geo_shape`**: good for search, but not a system of record.
- **`geography` column type**: slower bbox index and fewer functions (no GEOS validity or simplification without casts).
- **Storing projected (3857/ITM) coordinates**: distorts measurement and ties storage to one display CRS.
- **Event-sourced history only**: harder bbox queries; current state would need projections.
