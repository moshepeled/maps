/**
 * Operator actions on accounts (SPEC section 6.2 "Roles / admin bootstrap"), used by `scripts/user-admin.ts` - the only way to
 * create admins. `grant-admin` / `revoke-admin` change `users.role` without revoking sessions (`requireRole` reads the
 * CURRENT role on every admin request). `disable` sets `disabled_at` and revokes every active session in ONE
 * transaction, then marks each session revoked in Redis and publishes one `sessions` event per session; those Redis
 * steps are re-delivered for every recent admin revocation, so re-running `disable` after a Redis outage completes the
 * job. `enable` clears `disabled_at`. Every run is audited as `admin.user_update` (section 10.4).
 */
import type { AuditEvent, AuditLogger } from '../../infra/audit/types.js';
import type { Db } from '../../infra/db/types.js';
import type { RevocationNotifier } from './revocation-notifier.js';
import { listRecentAdminRevocations, revokeAllActiveSessionsForAdmin } from './sessions.repository.js';
import { canonicalUsername } from './username.js';
import { disableUser, enableUser, findUserByUsername, setUserRole } from './users.repository.js';
import type { UserRecord } from './users.repository.js';

export const USER_ADMIN_OPS = ['grant-admin', 'revoke-admin', 'disable', 'enable'] as const;

export type UserAdminOp = (typeof USER_ADMIN_OPS)[number];

/** A Redis step that failed after the database change committed. */
export interface RedisStepFailure {
  step: 'markRevoked' | 'publish';
  sessionId: string;
}

export interface UserAdminResult {
  op: UserAdminOp;
  userId: string;
  username: string;
  role: 'user' | 'admin';
  disabled: boolean;
  /** Sessions this run revoked (disable only). */
  revokedSessions: number;
  /** Admin revocations whose Redis mark and bus event this run delivered (disable only). */
  deliveredSessions: number;
  redisFailures: RedisStepFailure[];
}

export class UnknownUserError extends Error {
  readonly username: string;

  constructor(username: string) {
    super(`No user named ${username}.`);
    this.name = 'UnknownUserError';
    this.username = username;
  }
}

export interface UserAdminServiceDeps {
  db: Db;
  audit: AuditLogger;
  notifier: RevocationNotifier;
  /** ACCESS_TOKEN_TTL_S: an admin revocation older than this has no valid access token left to block. */
  accessTokenTtlS: number;
  /** The OS user running the CLI (audit `details.operator`); null when it cannot be determined. */
  operator: string | null;
}

interface AppliedChange {
  user: UserRecord;
  revokedSessionIds: string[];
  /** Sessions whose Redis mark + event must be (re)delivered. */
  toDeliver: string[];
}

export interface UserAdminService {
  /**
   * Throws UnknownUserError for an unknown username and rethrows any other database failure (both audited, nothing
   * changed); Redis failures after the commit are reported in the result, never thrown.
   */
  apply(op: UserAdminOp, username: string): Promise<UserAdminResult>;
}

/**
 * The `admin.user_update` failure row of a run whose transaction did not commit (section 10.4: every CLI run leaves one row).
 * No user id is known for certain (the lookup may be what failed), so the requested username is recorded instead.
 */
function uncommittedRunEvent(
  op: UserAdminOp,
  username: string,
  operator: string | null,
  error: unknown,
): AuditEvent {
  return {
    action: 'admin.user_update',
    outcome: 'failure',
    actorId: null,
    targetType: 'user',
    targetId: null,
    details: {
      op,
      operator,
      reason: error instanceof UnknownUserError ? 'user_not_found' : 'db_error',
      username,
    },
  };
}

export function createUserAdminService(deps: UserAdminServiceDeps): UserAdminService {
  const { db, audit, notifier, accessTokenTtlS, operator } = deps;

  /** The database change of one operation, in one transaction (the authoritative step). */
  async function applyInDatabase(op: UserAdminOp, username: string): Promise<AppliedChange> {
    // The CLI validates the name already; this guard keeps the service safe for any caller. A name outside the
    // registration pattern cannot belong to any account (username.ts).
    const canonical = canonicalUsername(username);
    if (canonical === null) throw new UnknownUserError(username);
    return db.withTransaction(async (tx) => {
      const found = await findUserByUsername(tx, canonical);
      if (found === null) throw new UnknownUserError(username);
      switch (op) {
        case 'grant-admin':
        case 'revoke-admin': {
          const user = await setUserRole(tx, found.id, op === 'grant-admin' ? 'admin' : 'user');
          return { user, revokedSessionIds: [], toDeliver: [] };
        }
        case 'disable': {
          const user = await disableUser(tx, found.id);
          const revokedSessionIds = await revokeAllActiveSessionsForAdmin(tx, found.id);
          // Includes the sessions just revoked (this transaction sees its own writes).
          const toDeliver = await listRecentAdminRevocations(tx, found.id, accessTokenTtlS);
          return { user, revokedSessionIds, toDeliver };
        }
        case 'enable': {
          const user = await enableUser(tx, found.id);
          return { user, revokedSessionIds: [], toDeliver: [] };
        }
      }
    });
  }

  async function deliverRevocations(
    userId: string,
    sessionIds: readonly string[],
  ): Promise<RedisStepFailure[]> {
    const failures: RedisStepFailure[] = [];
    for (const sessionId of sessionIds) {
      const delivery = await notifier.notify({ sessionId, userId, reason: 'admin' });
      if (!delivery.marked) failures.push({ step: 'markRevoked', sessionId });
      if (!delivery.published) failures.push({ step: 'publish', sessionId });
    }
    return failures;
  }

  return {
    async apply(op, username) {
      let change: AppliedChange;
      try {
        change = await applyInDatabase(op, username);
      } catch (error) {
        // `record` never throws or blocks: the buffered writer stores the row once the database is reachable again.
        audit.record(uncommittedRunEvent(op, username, operator, error));
        throw error;
      }

      const redisFailures = await deliverRevocations(change.user.id, change.toDeliver);
      const isDisable = op === 'disable';
      audit.record({
        action: 'admin.user_update',
        outcome: redisFailures.length === 0 ? 'success' : 'failure',
        actorId: null,
        targetType: 'user',
        targetId: change.user.id,
        details: {
          op,
          operator,
          ...(isDisable ? { revokedSessions: change.revokedSessionIds.length } : {}),
          ...(redisFailures.length > 0 ? { redisFailures: redisFailures.length } : {}),
        },
      });
      return {
        op,
        userId: change.user.id,
        username: change.user.username,
        role: change.user.role,
        disabled: change.user.disabledAt !== null,
        revokedSessions: change.revokedSessionIds.length,
        deliveredSessions: change.toDeliver.length,
        redisFailures,
      };
    },
  };
}
