/**
 * Auth fixtures written straight to the tables (SPEC section 12.2). `createUser()` inserts a user with an active session and
 * signs an access token with the container's service; the other helpers change rows in the database only (no Redis
 * mark, no bus event), as when those steps were lost. The password hash is a real argon2id PHC string (cheap
 * parameters for speed).
 */
import { randomBytes } from 'node:crypto';

import { hash } from '@node-rs/argon2';
import { USER_PALETTE } from '@snapland/shared';

import type { Container } from '../../src/container.js';
import type { AccessClaims } from '../../src/infra/auth/access-tokens.js';
import { sql } from '../../src/infra/db/types.js';
import { testRunId } from './test-app.js';

export const DEFAULT_TEST_PASSWORD = 'test-password-123';

const INSERT_USER = sql(
  'testFixtures.insertUser',
  `INSERT INTO users (username, display_name, password_hash, color, role, disabled_at)
   VALUES ($1, $2, $3, $4, $5, CASE WHEN $6::boolean THEN now() ELSE NULL END)
   RETURNING id, created_at`,
);

const INSERT_SESSION = sql(
  'testFixtures.insertSession',
  `INSERT INTO sessions (user_id, refresh_token_hash, user_agent, ip, expires_at, absolute_expires_at)
   VALUES ($1, $2, 'vitest', '127.0.0.1', now() + make_interval(secs => $3), now() + make_interval(secs => $4))
   RETURNING id`,
);

const REVOKE_SESSION = sql(
  'testFixtures.revokeSession',
  'UPDATE sessions SET revoked_at = now(), revoked_reason = $2 WHERE id = $1',
);

/** Exported for the auth kit's login/disable race, which runs it inside a transaction it keeps open. */
export const DISABLE_USER = sql(
  'testFixtures.disableUser',
  'UPDATE users SET disabled_at = now() WHERE id = $1',
);

export interface CreateUserOptions {
  displayName?: string;
  role?: 'user' | 'admin';
  color?: string;
  disabled?: boolean;
}

export interface TestUser {
  id: string;
  username: string;
  displayName: string;
  color: string;
  role: 'user' | 'admin';
  password: string;
  sessionId: string;
  accessToken: string;
  claims: AccessClaims;
}

let counter = 0;

/**
 * A username unique across the test files of a run (each file has its own module state, so a counter alone would
 * collide). Matches the handle form `^[A-Za-z0-9_.-]{3,32}$` for a prefix made of those characters.
 */
export function nextUsername(prefix = 'u'): string {
  return `${prefix}${testRunId()}${randomBytes(5).toString('hex')}`.slice(0, 32);
}

/** An active session of the user with the configured lifetimes (its refresh token is never needed, so it is random). */
export async function createSession(container: Container, userId: string): Promise<string> {
  const [session] = await container.db.query<{ id: string }>(INSERT_SESSION, [
    userId,
    randomBytes(32),
    container.config.REFRESH_TOKEN_TTL_S,
    container.config.SESSION_ABSOLUTE_TTL_S,
  ]);
  if (session === undefined) throw new Error('session insert returned no row');
  return session.id;
}

export async function revokeSessionInDb(
  container: Container,
  sessionId: string,
  reason: 'logout' | 'admin' = 'logout',
): Promise<void> {
  await container.db.query(REVOKE_SESSION, [sessionId, reason]);
}

export async function disableUserInDb(container: Container, userId: string): Promise<void> {
  await container.db.query(DISABLE_USER, [userId]);
}

export async function createUser(container: Container, options: CreateUserOptions = {}): Promise<TestUser> {
  counter += 1;
  const username = nextUsername();
  const displayName = options.displayName ?? `Test ${username}`;
  const role = options.role ?? 'user';
  const color = options.color ?? USER_PALETTE[counter % USER_PALETTE.length] ?? '#c44f9d';
  const passwordHash = await hash(DEFAULT_TEST_PASSWORD, { memoryCost: 1024, timeCost: 1, parallelism: 1 });

  const [user] = await container.db.query<{ id: string }>(INSERT_USER, [
    username,
    displayName,
    passwordHash,
    color,
    role,
    options.disabled === true,
  ]);
  if (user === undefined) throw new Error('user insert returned no row');
  const sessionId = await createSession(container, user.id);

  const claims: AccessClaims = { userId: user.id, sessionId, username, displayName, role };
  const { token } = await container.accessTokens.sign(claims);
  return {
    id: user.id,
    username,
    displayName,
    color,
    role,
    password: DEFAULT_TEST_PASSWORD,
    sessionId,
    accessToken: token,
    claims,
  };
}

export function bearer(user: Pick<TestUser, 'accessToken'>): { authorization: string } {
  return { authorization: `Bearer ${user.accessToken}` };
}
