/**
 * Every SQL statement of the areas module (SPEC section 5.5) as named, parameterised statements, and the calls that run them.
 * No business decisions here: the services choose which statement runs, in which transaction.
 *
 * Geometry enters as GeoJSON text already normalised by the service (7 dp, deduplicated) and is stored
 * counter-clockwise by `ST_ForcePolygonCCW`; it leaves as `ST_AsGeoJSON(...)::json`, which the pool parses to the
 * `{ type: 'Polygon', coordinates }` object the DTOs carry.
 */
import type {
  AreaDto,
  AreaOp,
  AreaVersionDto,
  Bbox,
  ChangeEventDto,
  ChangedField,
  PolygonGeometry,
} from '@snapland/shared';

import { sql } from '../../infra/db/types.js';
import type { DbTx } from '../../infra/db/types.js';
import { DIRECTORY_SQL } from '../../infra/directory/queries.js';
import type { LatestChangeSeqRow } from '../../infra/directory/queries.js';
import { toAreaDto, toAreaVersionDto, toBboxListRow, toChangeEventDto } from './areas.mapper.js';
import type { AreaRow, BboxListRow, BboxRow, ChangeRow, VersionRow } from './areas.mapper.js';
import type { GeometryCheck } from './geometry-pipeline.js';

/** `pg_advisory_xact_lock` key that serialises change_seq assignment with commit order (section 5.5). */
const CHANGE_FEED_LOCK_KEY = 7_210_001;

// Column lists are static SQL fragments (never values), shared so every statement returns the same row shape.
const AREA_COLUMNS = `a.id, a.name, a.description, ST_AsGeoJSON(a.geom, 7)::json AS geometry,
       a.area_km2, a.perimeter_km, a.vertex_count,
       ARRAY[ST_XMin(a.geom), ST_YMin(a.geom), ST_XMax(a.geom), ST_YMax(a.geom)] AS bbox,
       a.version, a.change_seq,
       a.created_by, cu.display_name AS created_by_name, cu.color AS created_by_color,
       a.updated_by, uu.display_name AS updated_by_name, uu.color AS updated_by_color,
       a.created_at, a.updated_at, a.deleted_at,
       a.deleted_by, du.display_name AS deleted_by_name, du.color AS deleted_by_color`;
const AREA_JOINS = `JOIN users cu ON cu.id = a.created_by
  JOIN users uu ON uu.id = a.updated_by
  LEFT JOIN users du ON du.id = a.deleted_by`;
const VERSION_COLUMNS = `v.area_id, v.version, v.op, v.name, v.description,
       v.area_km2, v.perimeter_km, v.vertex_count, v.changed_fields, v.merged, v.reverted_from, v.change_seq,
       v.actor_id, u.display_name AS actor_name, u.color AS actor_color, v.created_at`;

export const AREAS_SQL = {
  /** By id, soft-deleted rows included (the service decides whether a tombstone is visible). */
  findById: sql('areas.findById', `SELECT ${AREA_COLUMNS} FROM areas a ${AREA_JOINS} WHERE a.id = $1::uuid`),
  /**
   * Row lock that serialises writers of one area; always taken before the change-feed advisory lock. It locks the
   * `areas` row alone; `lockById` then reads the row with its user joins in a second statement (see there).
   */
  lockById: sql('areas.lockById', 'SELECT id FROM areas WHERE id = $1::uuid FOR UPDATE'),
  exists: sql('areas.exists', 'SELECT EXISTS (SELECT 1 FROM areas WHERE id = $1::uuid) AS exists'),
  /** Stage 13 of section 9.2 ($1 = GeoJSON text, already normalised and quantised by the service). */
  checkGeometry: sql(
    'areas.checkGeometry',
    `SELECT ST_IsValid(s.g) AS valid, ST_IsValidReason(s.g) AS reason, ST_Area(s.g::geography) / 1e6 AS area_km2
       FROM (SELECT ST_SetSRID(ST_GeomFromGeoJSON($1::text), 4326) AS g) AS s`,
  ),
  /** Held from nextval to COMMIT so commit order equals change_seq order (gap-free feed for readers, section 5.5). */
  lockChangeFeed: sql('areas.lockChangeFeed', `SELECT pg_advisory_xact_lock(${CHANGE_FEED_LOCK_KEY})`),
  /** $1 id, $2 name, $3 description, $4 GeoJSON, $5 actor. No row -> the id exists (idempotency check, section 6.3). */
  insert: sql(
    'areas.insert',
    `INSERT INTO areas (id, name, description, geom, area_km2, perimeter_km, vertex_count, bbox_extent_deg,
                        version, change_seq, created_by, updated_by)
     SELECT $1::uuid, $2::text, $3::text, s.g,
            ST_Area(s.g::geography) / 1e6, ST_Perimeter(s.g::geography) / 1e3,
            ST_NPoints(s.g) - ST_NRings(s.g),
            GREATEST(ST_XMax(s.g) - ST_XMin(s.g), ST_YMax(s.g) - ST_YMin(s.g)),
            1, nextval('area_change_seq'), $5::uuid, $5::uuid
       FROM (SELECT ST_ForcePolygonCCW(ST_SetSRID(ST_GeomFromGeoJSON($4::text), 4326)) AS g) AS s
     ON CONFLICT (id) DO NOTHING
     RETURNING id`,
  ),
  /**
   * $1 id, $2 name, $3 description (final values), $4 GeoJSON or NULL (geometry unchanged), $5 actor. Measurements
   * are recomputed only when a new geometry is given (every derived column COALESCEs to its current value).
   */
  updateContent: sql(
    'areas.updateContent',
    `UPDATE areas AS a
        SET name = $2::text,
            description = $3::text,
            geom = COALESCE(s.g, a.geom),
            area_km2 = COALESCE(ST_Area(s.g::geography) / 1e6, a.area_km2),
            perimeter_km = COALESCE(ST_Perimeter(s.g::geography) / 1e3, a.perimeter_km),
            vertex_count = COALESCE(ST_NPoints(s.g) - ST_NRings(s.g), a.vertex_count),
            bbox_extent_deg = COALESCE(GREATEST(ST_XMax(s.g) - ST_XMin(s.g), ST_YMax(s.g) - ST_YMin(s.g)),
                                       a.bbox_extent_deg),
            version = a.version + 1,
            change_seq = nextval('area_change_seq'),
            updated_by = $5::uuid,
            updated_at = now()
       FROM (SELECT ST_ForcePolygonCCW(ST_SetSRID(ST_GeomFromGeoJSON($4::text), 4326)) AS g) AS s
      WHERE a.id = $1::uuid`,
  ),
  /** $1 id, $2 actor. */
  softDelete: sql(
    'areas.softDelete',
    `UPDATE areas
        SET deleted_at = now(), deleted_by = $2::uuid,
            version = version + 1, change_seq = nextval('area_change_seq'), updated_by = $2::uuid, updated_at = now()
      WHERE id = $1::uuid`,
  ),
  /** $1 id, $2 actor. */
  restore: sql(
    'areas.restore',
    `UPDATE areas
        SET deleted_at = NULL, deleted_by = NULL,
            version = version + 1, change_seq = nextval('area_change_seq'), updated_by = $2::uuid, updated_at = now()
      WHERE id = $1::uuid`,
  ),
  /** Appends the full snapshot of the current row ($1 area, $2 op, $3 changed fields, $4 merged, $5 base version,
   *  $6 actor, $7 request id, $8 reverted_from). */
  insertVersionFromCurrent: sql(
    'areas.insertVersionFromCurrent',
    `INSERT INTO area_versions (area_id, version, op, name, description, geom, area_km2, perimeter_km, vertex_count,
                                changed_fields, merged, base_version, change_seq, actor_id, request_id, reverted_from)
     SELECT id, version, $2::text, name, description, geom, area_km2, perimeter_km, vertex_count,
            $3::text[], $4::boolean, $5::int, change_seq, $6::uuid, $7::text, $8::int
       FROM areas WHERE id = $1::uuid`,
  ),
  /** Idempotent-create check: compare the request with version 1 and its creator, not with the current row. */
  versionOneSnapshot: sql(
    'areas.versionOneSnapshot',
    `SELECT a.created_by, v.name, v.description, ST_AsGeoJSON(v.geom, 7)::json AS geometry
       FROM areas a JOIN area_versions v ON v.area_id = a.id AND v.version = 1
      WHERE a.id = $1::uuid`,
  ),
  /** The base snapshot of a three-way merge ($1 area, $2 version). */
  versionSnapshot: sql(
    'areas.versionSnapshot',
    `SELECT name, description, ST_AsGeoJSON(geom, 7)::json AS geometry
       FROM area_versions WHERE area_id = $1::uuid AND version = $2::int`,
  ),
  /** Union of changed_fields of the versions in ($2, $3] of area $1. */
  changedFieldsBetween: sql(
    'areas.changedFieldsBetween',
    `SELECT COALESCE(array_agg(DISTINCT f.field ORDER BY f.field), ARRAY[]::text[]) AS fields
       FROM area_versions v CROSS JOIN LATERAL unnest(v.changed_fields) AS f(field)
      WHERE v.area_id = $1::uuid AND v.version > $2::int AND v.version <= $3::int`,
  ),
  /**
   * First statement of the bbox read transaction: short OLTP reads where parallel-gather start-up dominated (section 5.5).
   * `set_config(..., true)` is `SET LOCAL` in a form that can be a named (prepared) statement.
   */
  bboxTxSettings: sql(
    'areas.bboxTxSettings',
    "SELECT set_config('max_parallel_workers_per_gather', '0', true)",
  ),
  /**
   * v1.2 budgeted bbox page (section 5.5). $1..$4 = snapped query bbox; $5 simplify tolerance (0 = none); $6 GeoJSON digits;
   * $7 min bbox_extent_deg; $8 cursor id or NULL; $9 limit + 1; $10 page position budget. GeoJSON is generated only for
   * rows inside the budget, so no more than one budget of geometry is ever materialised per page. The outer filter
   * keeps the rows inside the budget plus exactly one sentinel: `<=` (not `<`) so a sentinel is still returned when
   * the positions before it sum to the budget exactly (otherwise that page would end without a continuation).
   */
  findInBbox: sql(
    'areas.findInBbox',
    `SELECT p.id, p.name, p.area_km2, p.version, p.change_seq, p.updated_at, p.created_by, p.updated_by,
            u.display_name AS updated_by_name, u.color AS updated_by_color,
            CASE WHEN p.rn = 1 OR p.cum_positions <= $10::int THEN
              ST_AsGeoJSON(CASE WHEN $5::float8 > 0 THEN ST_Simplify(p.geom, $5::float8, true) ELSE p.geom END, $6::int)
            END::json AS geometry,
            ARRAY[ST_XMin(p.geom), ST_YMin(p.geom), ST_XMax(p.geom), ST_YMax(p.geom)] AS bbox
       FROM (
         SELECT a.id, a.name, a.area_km2, a.version, a.change_seq, a.updated_at, a.created_by, a.updated_by, a.geom,
                a.vertex_count,
                sum(a.vertex_count) OVER w AS cum_positions, row_number() OVER w AS rn
           FROM areas a
          WHERE a.deleted_at IS NULL
            AND ST_Intersects(a.geom, ST_MakeEnvelope($1::float8, $2::float8, $3::float8, $4::float8, 4326))
            AND a.bbox_extent_deg >= $7::float8
            AND ($8::uuid IS NULL OR a.id > $8::uuid)
         WINDOW w AS (ORDER BY a.id ROWS UNBOUNDED PRECEDING)
          ORDER BY a.id
          LIMIT $9::int
       ) p
       JOIN users u ON u.id = p.updated_by
      WHERE p.rn = 1 OR p.cum_positions - p.vertex_count <= $10::int
      ORDER BY p.id`,
  ),
  /** First page only: live areas in the query bbox omitted by the extent threshold, capped (10,000 = "or more"). */
  countCulled: sql(
    'areas.countCulled',
    `SELECT count(*)::int AS culled FROM (
       SELECT 1 FROM areas a
        WHERE a.deleted_at IS NULL
          AND ST_Intersects(a.geom, ST_MakeEnvelope($1::float8, $2::float8, $3::float8, $4::float8, 4326))
          AND a.bbox_extent_deg < $5::float8
        LIMIT $6::int) AS c`,
  ),
  /** History newest first, keyset on version ($2 = cursor or NULL, $3 = limit + 1, $4 = include geometry). */
  listVersions: sql(
    'areas.listVersions',
    `SELECT ${VERSION_COLUMNS},
            CASE WHEN $4::boolean THEN ST_AsGeoJSON(v.geom, 7) END::json AS geometry
       FROM area_versions v LEFT JOIN users u ON u.id = v.actor_id
      WHERE v.area_id = $1::uuid AND ($2::int IS NULL OR v.version < $2::int)
      ORDER BY v.version DESC
      LIMIT $3::int`,
  ),
  findVersion: sql(
    'areas.findVersion',
    `SELECT ${VERSION_COLUMNS}, ST_AsGeoJSON(v.geom, 7)::json AS geometry
       FROM area_versions v LEFT JOIN users u ON u.id = v.actor_id
      WHERE v.area_id = $1::uuid AND v.version = $2::int`,
  ),
  purgeWatermark: sql(
    'areas.purgeWatermark',
    "SELECT (value)::text::bigint AS watermark FROM system_state WHERE key = 'change_feed_purge_watermark'",
  ),
  /** Change feed ($1 since, $2 limit + 1), gap-free thanks to the change-feed advisory lock. */
  changesSince: sql(
    'areas.changesSince',
    `SELECT v.change_seq, v.op, v.area_id, v.version, v.name, v.description, ST_AsGeoJSON(v.geom, 7)::json AS geometry,
            v.area_km2, v.perimeter_km, v.vertex_count, v.changed_fields, v.merged, v.created_at,
            ARRAY[ST_XMin(v.geom), ST_YMin(v.geom), ST_XMax(v.geom), ST_YMax(v.geom)] AS bbox,
            v.actor_id, au.display_name AS actor_name, au.color AS actor_color,
            a.created_by, cu.display_name AS created_by_name, cu.color AS created_by_color,
            a.created_at AS area_created_at
       FROM area_versions v
       JOIN areas a ON a.id = v.area_id
       JOIN users cu ON cu.id = a.created_by
       LEFT JOIN users au ON au.id = v.actor_id
      WHERE v.change_seq > $1::bigint
      ORDER BY v.change_seq
      LIMIT $2::int`,
  ),
} as const;

export interface NewAreaValues {
  id: string;
  name: string;
  description: string | null;
  /** GeoJSON text of the normalised polygon. */
  geoJson: string;
  actorId: string;
}

export interface AreaContentValues {
  name: string;
  description: string | null;
  /** GeoJSON text of the new geometry, or null when the geometry is unchanged. */
  geoJson: string | null;
  actorId: string;
}

export interface VersionValues {
  areaId: string;
  op: AreaOp;
  changedFields: readonly ChangedField[];
  merged: boolean;
  baseVersion: number | null;
  actorId: string;
  requestId: string | null;
  revertedFrom: number | null;
}

export interface BboxQueryValues {
  queryBbox: Bbox;
  simplifyDeg: number;
  digits: number;
  minExtentDeg: number;
  afterId: string | null;
  /** limit + 1 (the extra row signals another page). */
  fetchLimit: number;
  positionBudget: number;
}

export interface VersionListValues {
  areaId: string;
  beforeVersion: number | null;
  /** limit + 1. */
  fetchLimit: number;
  includeGeometry: boolean;
}

/** Name, description and geometry of one stored version (the base of a three-way merge, section 10.3). */
export interface VersionSnapshot {
  name: string;
  description: string | null;
  geometry: PolygonGeometry;
}

/** The version-1 snapshot and creator used by the idempotent-create check (section 5.5). */
export interface VersionOneSnapshot extends VersionSnapshot {
  createdBy: string;
}

function firstRow<R>(rows: readonly R[], statement: string): R {
  const [row] = rows;
  if (row === undefined) throw new Error(`${statement} returned no row`);
  return row;
}

export const areasRepository = {
  async findById(q: DbTx, id: string): Promise<AreaDto | null> {
    const [row] = await q.query<AreaRow>(AREAS_SQL.findById, [id]);
    return row === undefined ? null : toAreaDto(row);
  },

  /**
   * Locks the row, then reads it with its user references in a NEW statement. A single locking SELECT that also joins
   * `users` loses the row under READ COMMITTED when the writer it waited for changed `updated_by`: PostgreSQL re-checks
   * the new row version (EvalPlanQual) against the users rows it read before the wait, the join condition fails and
   * the query returns nothing, which turned a 409 VERSION_CONFLICT into a 404 (found by T9). The second statement
   * takes a fresh snapshot, so it returns exactly the version committed by the previous lock holder.
   */
  async lockById(q: DbTx, id: string): Promise<AreaDto | null> {
    const locked = await q.query<{ id: string }>(AREAS_SQL.lockById, [id]);
    if (locked.length === 0) return null;
    const [row] = await q.query<AreaRow>(AREAS_SQL.findById, [id]);
    return row === undefined ? null : toAreaDto(row);
  },

  async exists(q: DbTx, id: string): Promise<boolean> {
    const rows = await q.query<{ exists: boolean }>(AREAS_SQL.exists, [id]);
    return firstRow(rows, AREAS_SQL.exists.name).exists;
  },

  async checkGeometry(q: DbTx, geoJson: string): Promise<GeometryCheck> {
    const rows = await q.query<{ valid: boolean; reason: string | null; area_km2: number | null }>(
      AREAS_SQL.checkGeometry,
      [geoJson],
    );
    const row = firstRow(rows, AREAS_SQL.checkGeometry.name);
    return { valid: row.valid, reason: row.reason, areaKm2: row.area_km2 };
  },

  async lockChangeFeed(q: DbTx): Promise<void> {
    await q.query(AREAS_SQL.lockChangeFeed);
  },

  /** False when the id already exists (`ON CONFLICT DO NOTHING`). */
  async insert(q: DbTx, values: NewAreaValues): Promise<boolean> {
    const rows = await q.query(AREAS_SQL.insert, [
      values.id,
      values.name,
      values.description,
      values.geoJson,
      values.actorId,
    ]);
    return rows.length === 1;
  },

  async updateContent(q: DbTx, id: string, values: AreaContentValues): Promise<void> {
    await q.query(AREAS_SQL.updateContent, [
      id,
      values.name,
      values.description,
      values.geoJson,
      values.actorId,
    ]);
  },

  async softDelete(q: DbTx, id: string, actorId: string): Promise<void> {
    await q.query(AREAS_SQL.softDelete, [id, actorId]);
  },

  async restore(q: DbTx, id: string, actorId: string): Promise<void> {
    await q.query(AREAS_SQL.restore, [id, actorId]);
  },

  async insertVersionFromCurrent(q: DbTx, values: VersionValues): Promise<void> {
    await q.query(AREAS_SQL.insertVersionFromCurrent, [
      values.areaId,
      values.op,
      [...values.changedFields],
      values.merged,
      values.baseVersion,
      values.actorId,
      values.requestId,
      values.revertedFrom,
    ]);
  },

  async versionOneSnapshot(q: DbTx, id: string): Promise<VersionOneSnapshot | null> {
    const [row] = await q.query<VersionSnapshot & { created_by: string }>(AREAS_SQL.versionOneSnapshot, [id]);
    if (row === undefined) return null;
    return {
      name: row.name,
      description: row.description,
      geometry: row.geometry,
      createdBy: row.created_by,
    };
  },

  async versionSnapshot(q: DbTx, id: string, version: number): Promise<VersionSnapshot | null> {
    const [row] = await q.query<VersionSnapshot>(AREAS_SQL.versionSnapshot, [id, version]);
    return row ?? null;
  },

  /** Fields changed by the versions in (afterVersion, upToVersion]. */
  async changedFieldsBetween(
    q: DbTx,
    id: string,
    afterVersion: number,
    upToVersion: number,
  ): Promise<ChangedField[]> {
    const rows = await q.query<{ fields: ChangedField[] }>(AREAS_SQL.changedFieldsBetween, [
      id,
      afterVersion,
      upToVersion,
    ]);
    return firstRow(rows, AREAS_SQL.changedFieldsBetween.name).fields;
  },

  async applyBboxTxSettings(q: DbTx): Promise<void> {
    await q.query(AREAS_SQL.bboxTxSettings);
  },

  /** `DIRECTORY_SQL.latestChangeSeq`, run inside the caller's snapshot (one definition for REST and WS, section 3.3). */
  async latestChangeSeq(q: DbTx): Promise<number> {
    const rows = await q.query<LatestChangeSeqRow>(DIRECTORY_SQL.latestChangeSeq);
    return firstRow(rows, DIRECTORY_SQL.latestChangeSeq.name).latest ?? 0;
  },

  async findInBbox(q: DbTx, values: BboxQueryValues): Promise<BboxListRow[]> {
    const [west, south, east, north] = values.queryBbox;
    const rows = await q.query<BboxRow>(AREAS_SQL.findInBbox, [
      west,
      south,
      east,
      north,
      values.simplifyDeg,
      values.digits,
      values.minExtentDeg,
      values.afterId,
      values.fetchLimit,
      values.positionBudget,
    ]);
    return rows.map(toBboxListRow);
  },

  async countCulled(q: DbTx, queryBbox: Bbox, minExtentDeg: number, cap: number): Promise<number> {
    const [west, south, east, north] = queryBbox;
    const rows = await q.query<{ culled: number }>(AREAS_SQL.countCulled, [
      west,
      south,
      east,
      north,
      minExtentDeg,
      cap,
    ]);
    return firstRow(rows, AREAS_SQL.countCulled.name).culled;
  },

  async listVersions(q: DbTx, values: VersionListValues): Promise<AreaVersionDto[]> {
    const rows = await q.query<VersionRow>(AREAS_SQL.listVersions, [
      values.areaId,
      values.beforeVersion,
      values.fetchLimit,
      values.includeGeometry,
    ]);
    return rows.map(toAreaVersionDto);
  },

  async findVersion(q: DbTx, id: string, version: number): Promise<AreaVersionDto | null> {
    const [row] = await q.query<VersionRow>(AREAS_SQL.findVersion, [id, version]);
    return row === undefined ? null : toAreaVersionDto(row);
  },

  async purgeWatermark(q: DbTx): Promise<number> {
    const [row] = await q.query<{ watermark: number | null }>(AREAS_SQL.purgeWatermark);
    return row?.watermark ?? 0;
  },

  async changesSince(q: DbTx, since: number, fetchLimit: number): Promise<ChangeEventDto[]> {
    const rows = await q.query<ChangeRow>(AREAS_SQL.changesSince, [since, fetchLimit]);
    return rows.map(toChangeEventDto);
  },
};
