/**
 * Statements of the read ports (SPEC section 3.3). `DIRECTORY_SQL.latestChangeSeq` is exported so the areas module runs the
 * very same statement inside its REPEATABLE READ bbox transaction (section 5.5): one definition for REST and WS.
 */
import { sql } from '../db/types.js';

/** section 0 "Active session" over `sessions s JOIN users u`: not revoked, inside both expiries, user not disabled. */
export const ACTIVE_SESSION_PREDICATE = `s.revoked_at IS NULL
      AND now() < s.expires_at
      AND now() < s.absolute_expires_at
      AND u.disabled_at IS NULL`;

export const DIRECTORY_SQL = {
  activeSession: sql(
    'directory.activeSession',
    `SELECT s.id AS session_id, s.user_id, u.role, s.absolute_expires_at, s.expires_at
       FROM sessions s JOIN users u ON u.id = s.user_id
      WHERE s.id = $1::uuid
        AND ${ACTIVE_SESSION_PREDICATE}`,
  ),
  activeSessions: sql(
    'directory.activeSessions',
    `SELECT s.id AS session_id, s.user_id, u.role, s.absolute_expires_at, s.expires_at
       FROM sessions s JOIN users u ON u.id = s.user_id
      WHERE s.id = ANY($1::uuid[])
        AND ${ACTIVE_SESSION_PREDICATE}`,
  ),
  userProfiles: sql(
    'directory.userProfiles',
    `SELECT id, display_name, color, role, disabled_at IS NOT NULL AS disabled
       FROM users
      WHERE id = ANY($1::uuid[])`,
  ),
  areaBbox: sql(
    'directory.areaBbox',
    `SELECT ST_XMin(geom) AS west, ST_YMin(geom) AS south, ST_XMax(geom) AS east, ST_YMax(geom) AS north
       FROM areas
      WHERE id = $1::uuid AND deleted_at IS NULL`,
  ),
  /**
   * Never below the purge watermark: after retention purged the areas holding the highest seqs, max(change_seq) can
   * drop below it, and a client using it as `since` would get 410 -> reload -> the same value -> 410 forever.
   */
  latestChangeSeq: sql(
    'directory.latestChangeSeq',
    `SELECT GREATEST(
              COALESCE((SELECT max(change_seq) FROM area_versions), 0),
              (SELECT (value)::text::bigint FROM system_state WHERE key = 'change_feed_purge_watermark')
            ) AS latest`,
  ),
} as const;

export interface ActiveSessionRow {
  session_id: string;
  user_id: string;
  role: 'user' | 'admin';
  absolute_expires_at: Date;
  expires_at: Date;
}

export interface UserProfileRow {
  id: string;
  display_name: string;
  color: string;
  role: 'user' | 'admin';
  disabled: boolean;
}

export interface AreaBboxRow {
  west: number;
  south: number;
  east: number;
  north: number;
}

export interface LatestChangeSeqRow {
  latest: number | null;
}
