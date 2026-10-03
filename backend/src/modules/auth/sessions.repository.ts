/**
 * SQL of the `sessions` table (SPEC section 5.2, section 6.2). Timestamps come from the database clock (`now()`), the same clock
 * the section 0 "active session" predicate uses, so REST, refresh and the WS re-validation agree on expiry.
 */
import type { DbTx } from '../../infra/db/types.js';
import { sql } from '../../infra/db/types.js';
import { ACTIVE_SESSION_PREDICATE } from '../../infra/directory/queries.js';
import type { RefreshCandidate } from './rotation.js';
import type { Role, UserProfile } from './users.repository.js';

export type RevokedReason = 'logout' | 'user_revoked' | 'token_reuse' | 'admin';

/** Upper bound of GET /auth/sessions (every login creates a session; the list must stay bounded). */
export const MAX_LISTED_SESSIONS = 100;

/** Columns of a session as shown to its owner; `host(ip)` renders the inet without a /32 mask. */
const SESSION_VIEW = `s.id, s.created_at, s.last_used_at, s.expires_at, s.absolute_expires_at, s.user_agent,
       host(s.ip) AS ip`;

/** The owner's profile columns of `sessions s JOIN users u`. */
const OWNER_COLUMNS = `u.id AS user_id, u.username, u.display_name, u.color, u.role, u.created_at AS user_created_at`;

export const SESSIONS_SQL = {
  /**
   * Inserts a session only while its user exists and is enabled. `FOR SHARE` on the user row closes the race with the
   * CLI's `disable` (UPDATE users, then revoke sessions, in one transaction): a login that reached this point before
   * the disable committed either waits for it and then re-checks `disabled_at` (no row), or commits first and is
   * then seen - and revoked - by the disable's session UPDATE, which blocks on this share lock until then.
   */
  insertForEnabledUser: sql(
    'auth.insertSessionForEnabledUser',
    `INSERT INTO sessions AS s (user_id, refresh_token_hash, user_agent, ip, expires_at, absolute_expires_at)
     SELECT u.id, $2::bytea, $3::text, $4::inet,
            now() + make_interval(secs => $5::double precision), now() + make_interval(secs => $6::double precision)
       FROM users u
      WHERE u.id = $1::uuid AND u.disabled_at IS NULL
        FOR SHARE OF u
     RETURNING ${SESSION_VIEW}`,
  ),
  /**
   * The row the presented token belongs to, locked for the rotation. Under READ COMMITTED a concurrent rotation of
   * the same token makes this statement wait and then re-evaluate against the committed row, which now matches as
   * `previous_token_hash` - so the loser of a parallel-tab race sees a fresh rotation (<= 10 s) instead of a reuse.
   * `db_now` is the transaction's clock, the one every session timestamp was written with.
   */
  findForRefresh: sql(
    'auth.findSessionForRefresh',
    `SELECT s.id, s.expires_at, s.absolute_expires_at, s.rotated_at, s.revoked_at,
            s.refresh_token_hash = $1 AS matched_current, u.disabled_at, ${OWNER_COLUMNS}, now() AS db_now
       FROM sessions s JOIN users u ON u.id = s.user_id
      WHERE s.refresh_token_hash = $1 OR s.previous_token_hash = $1
        FOR UPDATE OF s`,
  ),
  rotate: sql(
    'auth.rotateSession',
    `UPDATE sessions s
        SET previous_token_hash = s.refresh_token_hash,
            refresh_token_hash = $2,
            rotated_at = now(),
            last_used_at = now(),
            expires_at = $3
      WHERE s.id = $1::uuid
     RETURNING ${SESSION_VIEW}`,
  ),
  revoke: sql(
    'auth.revokeSession',
    `UPDATE sessions SET revoked_at = now(), revoked_reason = $3
      WHERE id = $1::uuid AND user_id = $2::uuid AND revoked_at IS NULL
     RETURNING id`,
  ),
  isOwnedBy: sql(
    'auth.sessionOwnedBy',
    'SELECT 1 AS owned FROM sessions WHERE id = $1::uuid AND user_id = $2::uuid',
  ),
  revokeAllActiveForAdmin: sql(
    'auth.revokeUserSessions',
    `UPDATE sessions SET revoked_at = now(), revoked_reason = 'admin'
      WHERE user_id = $1::uuid AND revoked_at IS NULL AND now() < expires_at AND now() < absolute_expires_at
     RETURNING id`,
  ),
  /** Admin revocations whose access tokens may still be valid (re-delivered by an idempotent re-run of `disable`). */
  recentAdminRevocations: sql(
    'auth.recentAdminRevocations',
    `SELECT id FROM sessions
      WHERE user_id = $1::uuid AND revoked_reason = 'admin' AND revoked_at > now() - make_interval(secs => $2)
      ORDER BY revoked_at, id`,
  ),
  listActive: sql(
    'auth.listActiveSessions',
    `SELECT ${SESSION_VIEW}
       FROM sessions s JOIN users u ON u.id = s.user_id
      WHERE s.user_id = $1::uuid AND ${ACTIVE_SESSION_PREDICATE}
      ORDER BY s.created_at DESC, s.id
      LIMIT $2`,
  ),
  findActiveWithUser: sql(
    'auth.findActiveSessionWithUser',
    `SELECT ${SESSION_VIEW}, ${OWNER_COLUMNS}
       FROM sessions s JOIN users u ON u.id = s.user_id
      WHERE s.id = $1::uuid AND s.user_id = $2::uuid AND ${ACTIVE_SESSION_PREDICATE}`,
  ),
} as const;

interface SessionViewRow {
  id: string;
  created_at: Date;
  last_used_at: Date;
  expires_at: Date;
  absolute_expires_at: Date;
  user_agent: string | null;
  ip: string | null;
}

interface OwnerRow {
  user_id: string;
  username: string;
  display_name: string;
  color: string;
  role: Role;
  user_created_at: Date;
}

interface RefreshRow extends OwnerRow {
  id: string;
  expires_at: Date;
  absolute_expires_at: Date;
  rotated_at: Date | null;
  revoked_at: Date | null;
  matched_current: boolean;
  disabled_at: Date | null;
  db_now: Date;
}

interface SessionWithOwnerRow extends SessionViewRow, OwnerRow {}

export interface SessionView {
  id: string;
  createdAt: Date;
  lastUsedAt: Date;
  expiresAt: Date;
  absoluteExpiresAt: Date;
  userAgent: string | null;
  ip: string | null;
}

export interface RefreshCandidateRow extends RefreshCandidate {
  sessionId: string;
  owner: UserProfile;
  /** The database time of the locking transaction. */
  dbNow: Date;
}

export interface SessionWithOwner {
  session: SessionView;
  owner: UserProfile;
}

export interface NewSession {
  userId: string;
  refreshTokenHash: Buffer;
  userAgent: string | null;
  ip: string | null;
  refreshTtlS: number;
  absoluteTtlS: number;
}

function toView(row: SessionViewRow): SessionView {
  return {
    id: row.id,
    createdAt: row.created_at,
    lastUsedAt: row.last_used_at,
    expiresAt: row.expires_at,
    absoluteExpiresAt: row.absolute_expires_at,
    userAgent: row.user_agent,
    ip: row.ip,
  };
}

function toOwner(row: OwnerRow): UserProfile {
  return {
    id: row.user_id,
    username: row.username,
    displayName: row.display_name,
    color: row.color,
    role: row.role,
    createdAt: row.user_created_at,
  };
}

/** The new session, or null when the user does not exist or is disabled (checked under a share lock). */
export async function insertSessionForEnabledUser(
  db: DbTx,
  session: NewSession,
): Promise<SessionView | null> {
  const [row] = await db.query<SessionViewRow>(SESSIONS_SQL.insertForEnabledUser, [
    session.userId,
    session.refreshTokenHash,
    session.userAgent,
    session.ip,
    session.refreshTtlS,
    session.absoluteTtlS,
  ]);
  return row === undefined ? null : toView(row);
}

/** Locks and returns the session whose current or previous refresh hash is `tokenHash` (null when none). */
export async function findSessionForRefresh(
  db: DbTx,
  tokenHash: Buffer,
): Promise<RefreshCandidateRow | null> {
  const [row] = await db.query<RefreshRow>(SESSIONS_SQL.findForRefresh, [tokenHash]);
  if (row === undefined) return null;
  return {
    sessionId: row.id,
    matched: row.matched_current ? 'current' : 'previous',
    revoked: row.revoked_at !== null,
    userDisabled: row.disabled_at !== null,
    expiresAt: row.expires_at,
    absoluteExpiresAt: row.absolute_expires_at,
    rotatedAt: row.rotated_at,
    owner: toOwner(row),
    dbNow: row.db_now,
  };
}

export async function rotateSession(
  db: DbTx,
  sessionId: string,
  newTokenHash: Buffer,
  expiresAt: Date,
): Promise<SessionView> {
  const [row] = await db.query<SessionViewRow>(SESSIONS_SQL.rotate, [sessionId, newTokenHash, expiresAt]);
  if (row === undefined) throw new Error('rotateSession produced no row');
  return toView(row);
}

/** True when this call revoked the session (false: unknown, someone else's, or already revoked). */
export async function revokeSession(
  db: DbTx,
  sessionId: string,
  userId: string,
  reason: RevokedReason,
): Promise<boolean> {
  const rows = await db.query<{ id: string }>(SESSIONS_SQL.revoke, [sessionId, userId, reason]);
  return rows.length > 0;
}

export async function isSessionOwnedBy(db: DbTx, sessionId: string, userId: string): Promise<boolean> {
  const rows = await db.query<{ owned: number }>(SESSIONS_SQL.isOwnedBy, [sessionId, userId]);
  return rows.length > 0;
}

/** Revokes every active session of the user with reason 'admin'; returns their ids. */
export async function revokeAllActiveSessionsForAdmin(db: DbTx, userId: string): Promise<string[]> {
  const rows = await db.query<{ id: string }>(SESSIONS_SQL.revokeAllActiveForAdmin, [userId]);
  return rows.map((row) => row.id);
}

export async function listRecentAdminRevocations(
  db: DbTx,
  userId: string,
  withinS: number,
): Promise<string[]> {
  const rows = await db.query<{ id: string }>(SESSIONS_SQL.recentAdminRevocations, [userId, withinS]);
  return rows.map((row) => row.id);
}

export async function listActiveSessions(db: DbTx, userId: string): Promise<SessionView[]> {
  const rows = await db.query<SessionViewRow>(SESSIONS_SQL.listActive, [userId, MAX_LISTED_SESSIONS]);
  return rows.map(toView);
}

export async function findActiveSessionWithUser(
  db: DbTx,
  sessionId: string,
  userId: string,
): Promise<SessionWithOwner | null> {
  const [row] = await db.query<SessionWithOwnerRow>(SESSIONS_SQL.findActiveWithUser, [sessionId, userId]);
  return row === undefined ? null : { session: toView(row), owner: toOwner(row) };
}
