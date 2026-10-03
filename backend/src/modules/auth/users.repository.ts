/**
 * SQL of the `users` table (SPEC section 5.2, section 6.2). Usernames are case-insensitive: every lookup is `lower(username) = $1`,
 * served by the unique index `users_username_lower_uq`. `$1` is the input already folded by `canonicalUsername` and is
 * deliberately not folded again: a database-side fold could disagree with the fold that keys the login failure
 * counters (see username.ts). Registration always inserts role 'user'; the role changes only through the operator CLI.
 */
import type { DbTx } from '../../infra/db/types.js';
import { sql } from '../../infra/db/types.js';
import type { CanonicalUsername } from './username.js';

const USER_COLUMNS = 'id, username, display_name, color, role, created_at, disabled_at';

export const USERS_SQL = {
  insert: sql(
    'auth.insertUser',
    `INSERT INTO users (id, username, display_name, password_hash, color, role)
     VALUES ($1::uuid, $2, $3, $4, $5, 'user')
     RETURNING ${USER_COLUMNS}`,
  ),
  findCredentials: sql(
    'auth.findUserCredentials',
    `SELECT ${USER_COLUMNS}, password_hash FROM users WHERE lower(username) = $1`,
  ),
  findByUsername: sql(
    'auth.findUserByUsername',
    `SELECT ${USER_COLUMNS} FROM users WHERE lower(username) = $1`,
  ),
  setRole: sql(
    'auth.setUserRole',
    `UPDATE users SET role = $2, updated_at = now()
      WHERE id = $1::uuid
     RETURNING ${USER_COLUMNS}`,
  ),
  /** Keeps the first disable time when the account is already disabled (idempotent re-runs). */
  disable: sql(
    'auth.disableUser',
    `UPDATE users SET disabled_at = COALESCE(disabled_at, now()), updated_at = now()
      WHERE id = $1::uuid
     RETURNING ${USER_COLUMNS}`,
  ),
  enable: sql(
    'auth.enableUser',
    `UPDATE users SET disabled_at = NULL, updated_at = now()
      WHERE id = $1::uuid
     RETURNING ${USER_COLUMNS}`,
  ),
} as const;

/** The unique index whose violation means "username taken" (23505). */
export const USERNAME_UNIQUE_INDEX = 'users_username_lower_uq';

export type Role = 'user' | 'admin';

interface UserRow {
  id: string;
  username: string;
  display_name: string;
  color: string;
  role: Role;
  created_at: Date;
  disabled_at: Date | null;
}

interface UserCredentialsRow extends UserRow {
  password_hash: string;
}

/** The public profile of a user: what `UserDto` and access tokens carry. */
export interface UserProfile {
  id: string;
  username: string;
  displayName: string;
  color: string;
  role: Role;
  createdAt: Date;
}

export interface UserRecord extends UserProfile {
  disabledAt: Date | null;
}

export interface UserCredentials {
  user: UserRecord;
  passwordHash: string;
}

export interface NewUser {
  id: string;
  username: string;
  displayName: string;
  passwordHash: string;
  color: string;
}

function toUser(row: UserRow): UserRecord {
  return {
    id: row.id,
    username: row.username,
    displayName: row.display_name,
    color: row.color,
    role: row.role,
    createdAt: row.created_at,
    disabledAt: row.disabled_at,
  };
}

/** The RETURNING row of a write; none means the caller's id did not exist (a programming error, not user input). */
function returned(rows: UserRow[]): UserRecord {
  const [row] = rows;
  if (row === undefined) throw new Error('users statement produced no row');
  return toUser(row);
}

/** Throws the driver's 23505 on `users_username_lower_uq` when the username is taken (see isUsernameTaken). */
export async function insertUser(db: DbTx, user: NewUser): Promise<UserRecord> {
  return returned(
    await db.query<UserRow>(USERS_SQL.insert, [
      user.id,
      user.username,
      user.displayName,
      user.passwordHash,
      user.color,
    ]),
  );
}

export async function findUserCredentials(
  db: DbTx,
  username: CanonicalUsername,
): Promise<UserCredentials | null> {
  const [row] = await db.query<UserCredentialsRow>(USERS_SQL.findCredentials, [username]);
  return row === undefined ? null : { user: toUser(row), passwordHash: row.password_hash };
}

export async function findUserByUsername(db: DbTx, username: CanonicalUsername): Promise<UserRecord | null> {
  const [row] = await db.query<UserRow>(USERS_SQL.findByUsername, [username]);
  return row === undefined ? null : toUser(row);
}

export async function setUserRole(db: DbTx, userId: string, role: Role): Promise<UserRecord> {
  return returned(await db.query<UserRow>(USERS_SQL.setRole, [userId, role]));
}

export async function disableUser(db: DbTx, userId: string): Promise<UserRecord> {
  return returned(await db.query<UserRow>(USERS_SQL.disable, [userId]));
}

export async function enableUser(db: DbTx, userId: string): Promise<UserRecord> {
  return returned(await db.query<UserRow>(USERS_SQL.enable, [userId]));
}

/** True for the unique violation of the case-insensitive username index. */
export function isUsernameTaken(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    error.code === '23505' &&
    'constraint' in error &&
    error.constraint === USERNAME_UNIQUE_INDEX
  );
}
