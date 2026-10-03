/**
 * Test fixture SQL for the retention suite (SPEC section 5.6): rows whose age is chosen by the test - soft-deleted areas with
 * their create/delete versions, audit rows and dead sessions - inserted in bulk (one statement each), because the
 * application only ever stamps "now". Every fixture is tagged (area name, audit instance id, session user agent) so
 * the assertions look only at the suite's own rows in the run's shared database.
 */
import type { Container } from '../../../../src/container.js';
import { sql } from '../../../../src/infra/db/types.js';

const DAY_S = 86_400;

/**
 * `$2` areas soft-deleted `$3` days ago (NULL -> live), each with version 1 (`create`) and - when deleted - version 2
 * (`delete`), consuming change_seq values from the real sequence so the change feed sees them in commit order. Small
 * valid squares in a grid near (34.70, 31.90); metrics computed by PostGIS exactly as the areas module stores them.
 */
const INSERT_AREAS = sql(
  'retentionFixtures.insertAreas',
  `WITH src AS (
     SELECT gen_random_uuid() AS id,
            ST_MakeEnvelope(34.70 + (i % 100) * 0.001, 31.90 + (i / 100) * 0.001,
                            34.7005 + (i % 100) * 0.001, 31.9005 + (i / 100) * 0.001, 4326) AS g,
            nextval('area_change_seq') AS create_seq,
            CASE WHEN $3::float8 IS NULL THEN NULL ELSE nextval('area_change_seq') END AS delete_seq,
            now() - make_interval(secs => COALESCE($3::float8, 0) * ${DAY_S}) AS deleted_at
     FROM generate_series(1, $2::int) AS i
   ), inserted_areas AS (
     INSERT INTO areas (id, name, geom, area_km2, perimeter_km, vertex_count, bbox_extent_deg, version, change_seq,
                        created_by, updated_by, created_at, updated_at, deleted_at, deleted_by)
     SELECT id, $4, g, ST_Area(g::geography) / 1e6, ST_Perimeter(g::geography) / 1e3, 4, 0.0005,
            CASE WHEN delete_seq IS NULL THEN 1 ELSE 2 END, COALESCE(delete_seq, create_seq), $1, $1,
            deleted_at - interval '1 day', deleted_at,
            CASE WHEN delete_seq IS NULL THEN NULL ELSE deleted_at END,
            CASE WHEN delete_seq IS NULL THEN NULL ELSE $1::uuid END
     FROM src
     RETURNING id
   ), inserted_versions AS (
     INSERT INTO area_versions (area_id, version, op, name, geom, area_km2, perimeter_km, vertex_count,
                                changed_fields, change_seq, actor_id, created_at)
     SELECT id, 1, 'create', $4, g, ST_Area(g::geography) / 1e6, ST_Perimeter(g::geography) / 1e3, 4,
            ARRAY['name', 'description', 'geometry'], create_seq, $1, deleted_at - interval '1 day'
     FROM src
     UNION ALL
     SELECT id, 2, 'delete', $4, g, ST_Area(g::geography) / 1e6, ST_Perimeter(g::geography) / 1e3, 4,
            ARRAY['deleted'], delete_seq, $1, deleted_at
     FROM src WHERE delete_seq IS NOT NULL
   )
   SELECT id FROM src`,
);

/** `$2` audit rows `$3` days old under instance id `$1`. */
const INSERT_AUDIT = sql(
  'retentionFixtures.insertAudit',
  `INSERT INTO audit_logs (occurred_at, action, outcome, instance_id, details)
   SELECT now() - make_interval(secs => $3::float8 * ${DAY_S}), 'area.create', 'success', $1, '{}'::jsonb
   FROM generate_series(1, $2::int)`,
);

/**
 * `$3` sessions of user `$1`, tagged by user agent `$2`: `$4` = 'expired' (expired `$5` days ago) or 'revoked'
 * (revoked `$5` days ago, still unexpired). Each gets a unique random refresh-token hash.
 */
const INSERT_SESSIONS = sql(
  'retentionFixtures.insertSessions',
  `INSERT INTO sessions (user_id, refresh_token_hash, user_agent, expires_at, absolute_expires_at,
                         revoked_at, revoked_reason)
   SELECT $1, sha256(convert_to(gen_random_uuid()::text, 'UTF8')), $2,
          CASE WHEN $4 = 'expired' THEN now() - make_interval(secs => $5::float8 * ${DAY_S})
               ELSE now() + interval '1 day' END,
          now() + interval '30 days',
          CASE WHEN $4 = 'revoked' THEN now() - make_interval(secs => $5::float8 * ${DAY_S}) END,
          CASE WHEN $4 = 'revoked' THEN 'logout' END
   FROM generate_series(1, $3::int)`,
);

const COUNT_AREAS = sql(
  'retentionFixtures.countAreas',
  'SELECT count(*)::int AS n FROM areas WHERE id = ANY($1)',
);
const COUNT_VERSIONS = sql(
  'retentionFixtures.countVersions',
  'SELECT count(*)::int AS n FROM area_versions WHERE area_id = ANY($1)',
);
const MAX_VERSION_SEQ = sql(
  'retentionFixtures.maxVersionSeq',
  'SELECT COALESCE(max(change_seq), 0) AS m FROM area_versions WHERE area_id = ANY($1)',
);
const COUNT_AUDIT = sql(
  'retentionFixtures.countAudit',
  'SELECT count(*)::int AS n FROM audit_logs WHERE instance_id = $1',
);
const COUNT_SESSIONS = sql(
  'retentionFixtures.countSessions',
  'SELECT count(*)::int AS n FROM sessions WHERE user_agent = $1',
);
const READ_STATE = sql('retentionFixtures.readState', 'SELECT value FROM system_state WHERE key = $1');
const DELETE_AUDIT = sql('retentionFixtures.deleteAudit', 'DELETE FROM audit_logs WHERE instance_id = $1');
const DELETE_SESSIONS = sql('retentionFixtures.deleteSessions', 'DELETE FROM sessions WHERE user_agent = $1');
const DELETE_AREAS = sql('retentionFixtures.deleteAreas', 'DELETE FROM areas WHERE name = $1');

async function count(
  container: Container,
  stmt: typeof COUNT_AUDIT,
  params: readonly unknown[],
): Promise<number> {
  const [row] = await container.db.query<{ n: number }>(stmt, params);
  return row?.n ?? 0;
}

/** Tagged fixtures of one suite. */
export class RetentionFixtures {
  readonly #container: Container;
  readonly #tag: string;

  constructor(container: Container, tag: string) {
    this.#container = container;
    this.#tag = tag;
  }

  /** Inserts `n` areas owned by `ownerId`, soft-deleted `deletedDaysAgo` days ago (null -> live); returns their ids. */
  async insertAreas(ownerId: string, n: number, deletedDaysAgo: number | null): Promise<string[]> {
    const rows = await this.#container.db.query<{ id: string }>(INSERT_AREAS, [
      ownerId,
      n,
      deletedDaysAgo,
      this.#tag,
    ]);
    return rows.map((row) => row.id);
  }

  async insertAudit(n: number, daysAgo: number): Promise<void> {
    await this.#container.db.query(INSERT_AUDIT, [this.#tag, n, daysAgo]);
  }

  /** Inserts `n` sessions tagged `<tag>:<label>` so each group can be counted on its own. */
  async insertSessions(
    userId: string,
    label: string,
    n: number,
    kind: 'expired' | 'revoked',
    daysAgo: number,
  ): Promise<void> {
    await this.#container.db.query(INSERT_SESSIONS, [userId, this.sessionTag(label), n, kind, daysAgo]);
  }

  sessionTag(label: string): string {
    return `${this.#tag}:${label}`;
  }

  countAreas(ids: readonly string[]): Promise<number> {
    return count(this.#container, COUNT_AREAS, [ids]);
  }

  countVersions(ids: readonly string[]): Promise<number> {
    return count(this.#container, COUNT_VERSIONS, [ids]);
  }

  async maxVersionSeq(ids: readonly string[]): Promise<number> {
    const [row] = await this.#container.db.query<{ m: number }>(MAX_VERSION_SEQ, [ids]);
    return row?.m ?? 0;
  }

  countAudit(): Promise<number> {
    return count(this.#container, COUNT_AUDIT, [this.#tag]);
  }

  countSessions(label: string): Promise<number> {
    return count(this.#container, COUNT_SESSIONS, [this.sessionTag(label)]);
  }

  /** A `system_state` value (`change_feed_purge_watermark`, `retention_last_run`). */
  async readState<T>(key: string): Promise<T | undefined> {
    const [row] = await this.#container.db.query<{ value: T }>(READ_STATE, [key]);
    return row?.value;
  }

  /** Removes the suite's rows the purge kept (the younger fixtures), so later suites see clean tables. */
  async cleanup(sessionLabels: readonly string[]): Promise<void> {
    await this.#container.db.query(DELETE_AUDIT, [this.#tag]);
    for (const label of sessionLabels) {
      await this.#container.db.query(DELETE_SESSIONS, [this.sessionTag(label)]);
    }
    await this.#container.db.query(DELETE_AREAS, [this.#tag]);
  }
}
