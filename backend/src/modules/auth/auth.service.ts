/**
 * Accounts and sessions (SPEC section 6.2): register, login (with the section 10.1 failure counters), refresh-token rotation with
 * reuse detection, and logout. Every outcome a handler produces is audited here (section 10.4 `auth.*`); the generic
 * onResponse hook only fills in transport failures (400/413/415/5xx).
 *
 * Order of side effects: database first (authoritative, in one transaction where several rows change), then the
 * best-effort Redis steps (revocation marks, bus events), then the audit event.
 */
import { randomUUID } from 'node:crypto';

import { LIMITS, sanitizeText } from '@snapland/shared';
import type { AuthResponse, LoginRequest, RegisterRequest } from '@snapland/shared';

import type { AccessTokenService } from '../../infra/auth/access-tokens.js';
import type { AuditCoalescer, AuditEvent, AuditLogger } from '../../infra/audit/types.js';
import type { Db, DbTx } from '../../infra/db/types.js';
import {
  ConflictError,
  ForbiddenError,
  RateLimitedError,
  UnauthorizedError,
  ValidationError,
} from '../../infra/http/errors.js';
import type { ActorContext } from '../../infra/http/request-context.js';
import type { Logger } from '../../infra/logger.js';
import type { Metrics } from '../../infra/metrics/metrics.js';
import { actorAuditFields, requireSessionActor } from './auth-context.js';
import { toUserDto } from './auth.mapper.js';
import type { LoginFailureCounter, LoginLockout } from './login-failures.js';
import { colorForUser } from './palette.js';
import type { PasswordHasher } from './passwords.js';
import {
  generateRefreshToken,
  hashRefreshToken,
  isWellFormedRefreshToken,
  refreshCookieMaxAgeS,
} from './refresh-tokens.js';
import type { RevocationNotifier } from './revocation-notifier.js';
import { decideRotation } from './rotation.js';
import type { RotationRejection } from './rotation.js';
import {
  findSessionForRefresh,
  insertSessionForEnabledUser,
  revokeSession,
  rotateSession,
} from './sessions.repository.js';
import type { RefreshCandidateRow, SessionView } from './sessions.repository.js';
import { canonicalUsername } from './username.js';
import type { CanonicalUsername } from './username.js';
import { findUserCredentials, insertUser, isUsernameTaken } from './users.repository.js';
import type { UserCredentials, UserProfile, UserRecord } from './users.repository.js';

/** One detail for both "unknown user" and "wrong password": the bodies must be byte-identical (section 3.5). */
const INVALID_CREDENTIALS_DETAIL = 'Invalid username or password.';
const UNKNOWN_IP = 'unknown';

export interface AuthSettings {
  refreshTokenTtlS: number;
  sessionAbsoluteTtlS: number;
}

export interface AuthServiceDeps {
  db: Db;
  accessTokens: AccessTokenService;
  audit: AuditLogger;
  auditCoalescer: AuditCoalescer;
  metrics: Metrics;
  logger: Logger;
  passwords: PasswordHasher;
  loginFailures: LoginFailureCounter;
  notifier: RevocationNotifier;
  settings: AuthSettings;
}

/** A started or rotated session: the response body plus the refresh token the route puts in the cookie. */
export interface IssuedSession {
  body: AuthResponse;
  refreshToken: string;
  refreshCookieMaxAgeS: number;
}

/** A new or rotated session row with the refresh token that was just hashed into it. */
interface StartedSession {
  session: SessionView;
  refreshToken: string;
  refreshCookieMaxAgeS: number;
}

type RefreshOutcome =
  | { kind: 'rotated'; row: RefreshCandidateRow; started: StartedSession }
  | { kind: 'reused'; row: RefreshCandidateRow }
  | { kind: 'rejected'; row: RefreshCandidateRow | null; rejection: RotationRejection };

export class AuthService {
  readonly #deps: AuthServiceDeps;

  constructor(deps: AuthServiceDeps) {
    this.#deps = deps;
  }

  async register(input: RegisterRequest, actor: ActorContext): Promise<IssuedSession> {
    const displayName = this.#sanitizedDisplayName(input.displayName, actor);
    const passwordHash = await this.#deps.passwords.hash(input.password);
    const { user, started } = await this.#createAccount(
      { username: input.username, displayName, passwordHash },
      actor,
    );
    const issued = await this.#issue(user, started);
    this.#audit(actor, {
      action: 'auth.register',
      outcome: 'success',
      actorId: user.id,
      sessionId: started.session.id,
      targetType: 'user',
      targetId: user.id,
    });
    return issued;
  }

  async login(input: LoginRequest, actor: ActorContext): Promise<IssuedSession> {
    // Folded once: this one value keys the failure counters AND the account lookup (see username.ts).
    const username = canonicalUsername(input.username);
    if (username === null) {
      // A name outside the (public) registration pattern cannot belong to any account: it gets the unknown-user
      // treatment - one dummy verification and the same 401 body - without touching the counters or the database.
      await this.#deps.passwords.verifyDummy(input.password);
      this.#rejectInvalidCredentials(actor, null);
    }

    // The attempt is counted atomically with the lockout check, before the password is verified, so a burst of
    // parallel attempts cannot all pass a check that runs before any of them is recorded (section 6.2 limits).
    const admission = await this.#deps.loginFailures.admit(username, actor.ip);
    if (admission.locked) this.#rejectLockedLogin(actor, admission);
    const user = await this.#authenticate(username, input.password, actor, admission.reserved);

    await this.#deps.loginFailures.reset(username, actor.ip);
    const started = await this.#startSession(this.#deps.db, user.id, actor);
    // The account was disabled between the password check and the session insert (see insertSessionForEnabledUser).
    if (started === null) this.#rejectDisabled(user.id, actor);
    const issued = await this.#issue(user, started);
    this.#audit(actor, {
      action: 'auth.login',
      outcome: 'success',
      actorId: user.id,
      sessionId: started.session.id,
      targetType: 'user',
      targetId: user.id,
    });
    return issued;
  }

  async refresh(presentedToken: string | undefined, actor: ActorContext): Promise<IssuedSession> {
    if (presentedToken === undefined || !isWellFormedRefreshToken(presentedToken)) {
      this.#auditRefreshFailure(actor, null, presentedToken === undefined ? 'missing' : 'malformed');
      throw new UnauthorizedError('REFRESH_TOKEN_INVALID', 'The refresh token is missing or invalid.');
    }

    const outcome = await this.#deps.db.withTransaction((tx) => this.#rotate(tx, presentedToken));
    if (outcome.kind === 'rotated') {
      const { row, started } = outcome;
      const issued = await this.#issue(row.owner, started);
      this.#audit(actor, {
        action: 'auth.refresh',
        outcome: 'success',
        actorId: row.owner.id,
        sessionId: row.sessionId,
        targetType: 'session',
        targetId: row.sessionId,
      });
      return issued;
    }
    if (outcome.kind === 'reused') {
      // Rule 2 reuse: the revocation is committed; now the Redis mark, the bus event, the audit row and the 401.
      const { sessionId, owner } = outcome.row;
      await this.#deps.notifier.notify({ sessionId, userId: owner.id, reason: 'token_reuse' });
      this.#audit(actor, {
        action: 'auth.token_reuse',
        outcome: 'denied',
        actorId: owner.id,
        sessionId,
        targetType: 'session',
        targetId: sessionId,
        details: {},
      });
      this.#deps.logger.warn(
        { sessionId, userId: owner.id },
        'refresh token reuse detected; session revoked',
      );
      throw new UnauthorizedError(
        'REFRESH_TOKEN_REUSED',
        'This refresh token was already used; the session has been revoked.',
      );
    }
    this.#auditRefreshFailure(actor, outcome.row, outcome.rejection.reason);
    throw new UnauthorizedError(
      outcome.rejection.code,
      outcome.rejection.code === 'SESSION_REVOKED'
        ? 'The session has been revoked.'
        : 'The refresh token is missing or invalid.',
    );
  }

  async logout(actor: ActorContext): Promise<void> {
    const { userId, sessionId } = requireSessionActor(actor);
    const revoked = await revokeSession(this.#deps.db, sessionId, userId, 'logout');
    // An already revoked session (e.g. a second logout) needs no new mark or event.
    if (revoked) await this.#deps.notifier.notify({ sessionId, userId, reason: 'logout' });
    this.#audit(actor, {
      action: 'auth.logout',
      outcome: 'success',
      actorId: userId,
      sessionId,
      targetType: 'session',
      targetId: sessionId,
      details: revoked ? {} : { alreadyRevoked: true },
    });
  }

  /** Sanitised display name (section 10.7.1), or 400 VALIDATION_FAILED (audited) when nothing valid remains. */
  #sanitizedDisplayName(raw: string, actor: ActorContext): string {
    const result = sanitizeText(raw, { maxLength: LIMITS.displayNameMaxLength });
    if (result.ok) return result.value;
    this.#audit(actor, {
      action: 'auth.register',
      outcome: 'failure',
      targetType: 'user',
      details: { reason: 'invalid_display_name', code: 'VALIDATION_FAILED', status: 400 },
    });
    throw new ValidationError('The display name is invalid.', [
      {
        path: 'body.displayName',
        code: result.reason,
        message:
          result.reason === 'empty'
            ? 'must contain at least one visible character'
            : `must be at most ${result.maxLength} characters`,
      },
    ]);
  }

  /** User + first session in one transaction; 409 USERNAME_TAKEN (audited) on the case-insensitive unique index. */
  async #createAccount(
    account: { username: string; displayName: string; passwordHash: string },
    actor: ActorContext,
  ): Promise<{ user: UserProfile; started: StartedSession }> {
    // The id is chosen here so the colour (derived from it) is part of the single INSERT.
    const userId = randomUUID();
    try {
      return await this.#deps.db.withTransaction(async (tx) => {
        const user = await insertUser(tx, { id: userId, ...account, color: colorForUser(userId) });
        const started = await this.#startSession(tx, user.id, actor);
        // Unreachable: the user was inserted, enabled, by this very transaction.
        if (started === null) throw new Error('the new user could not start a session');
        return { user, started };
      });
    } catch (error) {
      if (!isUsernameTaken(error)) throw error;
      this.#audit(actor, {
        action: 'auth.register',
        outcome: 'failure',
        targetType: 'user',
        details: { reason: 'username_taken', code: 'USERNAME_TAKEN', status: 409 },
      });
      throw new ConflictError('USERNAME_TAKEN', 'This username is already taken.');
    }
  }

  /**
   * The enabled user whose password matches. The attempt was already counted as a failure (`admit`): a wrong password
   * or unknown username leaves that count in place -> 401 INVALID_CREDENTIALS; anything that is not a failed guess - a
   * disabled account (checked only after the password, so nobody learns that an account exists or is disabled) or a
   * database/hashing error - gives the count back, so it cannot lock the user out.
   */
  async #authenticate(
    username: CanonicalUsername,
    password: string,
    actor: ActorContext,
    reserved: boolean,
  ): Promise<UserRecord> {
    const { db, passwords, loginFailures } = this.#deps;
    const giveBackAttempt = (): Promise<void> =>
      reserved ? loginFailures.release(username, actor.ip) : Promise.resolve();
    let stored: UserCredentials | null;
    let matched: boolean;
    try {
      stored = await findUserCredentials(db, username);
      // An unknown username still pays for one full verification (the dummy hash), so timing does not reveal
      // whether the account exists.
      matched =
        stored === null
          ? await passwords.verifyDummy(password)
          : await passwords.verify(stored.passwordHash, password);
    } catch (error) {
      await giveBackAttempt();
      throw error;
    }
    if (stored === null || !matched) this.#rejectInvalidCredentials(actor, stored?.user.id ?? null);
    if (stored.user.disabledAt !== null) {
      await giveBackAttempt();
      this.#rejectDisabled(stored.user.id, actor);
    }
    return stored.user;
  }

  /** 401 INVALID_CREDENTIALS, audited; one body for an unknown username and a wrong password (section 3.5). */
  #rejectInvalidCredentials(actor: ActorContext, userId: string | null): never {
    this.#audit(actor, {
      action: 'auth.login',
      outcome: 'failure',
      targetType: 'user',
      targetId: userId,
      details: { reason: 'invalid_credentials' },
    });
    throw new UnauthorizedError('INVALID_CREDENTIALS', INVALID_CREDENTIALS_DETAIL);
  }

  /** 403 ACCOUNT_DISABLED, audited as a denied login. */
  #rejectDisabled(userId: string, actor: ActorContext): never {
    this.#audit(actor, {
      action: 'auth.login',
      outcome: 'denied',
      targetType: 'user',
      targetId: userId,
      details: { reason: 'disabled' },
    });
    throw new ForbiddenError('ACCOUNT_DISABLED', 'This account is disabled.');
  }

  /** One transaction: lock the session of the presented token, decide (section 6.2 rules 1-3), apply the decision. */
  async #rotate(tx: DbTx, presentedToken: string): Promise<RefreshOutcome> {
    const row = await findSessionForRefresh(tx, hashRefreshToken(presentedToken));
    if (row === null) {
      // Rule 3: no session has the presented token as its current or previous token.
      return {
        kind: 'rejected',
        row,
        rejection: { kind: 'reject', code: 'REFRESH_TOKEN_INVALID', reason: 'unknown' },
      };
    }
    const decision = decideRotation(row, row.dbNow, this.#deps.settings.refreshTokenTtlS);
    switch (decision.kind) {
      case 'rotate': {
        const next = generateRefreshToken();
        const session = await rotateSession(tx, row.sessionId, next.hash, decision.expiresAt);
        return {
          kind: 'rotated',
          row,
          started: {
            session,
            refreshToken: next.token,
            refreshCookieMaxAgeS: refreshCookieMaxAgeS(decision.expiresAt, row.dbNow),
          },
        };
      }
      case 'reuse':
        await revokeSession(tx, row.sessionId, row.owner.id, 'token_reuse');
        return { kind: 'reused', row };
      case 'reject':
        return { kind: 'rejected', row, rejection: decision };
    }
  }

  /** A new session for the user, or null when the account is (by now) disabled. */
  async #startSession(db: DbTx, userId: string, actor: ActorContext): Promise<StartedSession | null> {
    const { refreshTokenTtlS, sessionAbsoluteTtlS } = this.#deps.settings;
    const refresh = generateRefreshToken();
    const session = await insertSessionForEnabledUser(db, {
      userId,
      refreshTokenHash: refresh.hash,
      userAgent: actor.userAgent,
      ip: actor.ip,
      refreshTtlS: refreshTokenTtlS,
      absoluteTtlS: sessionAbsoluteTtlS,
    });
    // A fresh session's cookie lives exactly its sliding lifetime.
    return session === null
      ? null
      : { session, refreshToken: refresh.token, refreshCookieMaxAgeS: refreshTokenTtlS };
  }

  async #issue(user: UserProfile, started: StartedSession): Promise<IssuedSession> {
    const { token, expiresAt } = await this.#deps.accessTokens.sign({
      userId: user.id,
      sessionId: started.session.id,
      username: user.username,
      displayName: user.displayName,
      role: user.role,
    });
    return {
      body: {
        user: toUserDto(user),
        sessionId: started.session.id,
        accessToken: token,
        accessTokenExpiresAt: expiresAt.toISOString(),
      },
      refreshToken: started.refreshToken,
      refreshCookieMaxAgeS: started.refreshCookieMaxAgeS,
    };
  }

  /**
   * A locked (username, IP) or username: 429 `scope: login`, counted, and reported to the audit coalescer (one row per
   * IP per 10 s window however many attempts follow, section 10.4), plus the coalesced `auth.login` denial.
   */
  #rejectLockedLogin(actor: ActorContext, lockout: LoginLockout): never {
    const { metrics, auditCoalescer } = this.#deps;
    const ip = actor.ip ?? UNKNOWN_IP;
    metrics.rateLimitRejectionsTotal.inc({ scope: 'login', transport: 'rest' });
    auditCoalescer.record(`ratelimit:login:${ip}`, {
      ...actorAuditFields(actor),
      action: 'ratelimit.hit',
      outcome: 'denied',
      targetType: null,
      targetId: null,
      details: { scope: 'login', transport: 'rest', limit: lockout.limit, counter: lockout.counter },
    });
    auditCoalescer.record(`auth.login:denied:RATE_LIMITED:${ip}`, {
      ...actorAuditFields(actor),
      action: 'auth.login',
      outcome: 'denied',
      targetType: 'user',
      targetId: null,
      details: { reason: 'locked', code: 'RATE_LIMITED' },
    });
    throw new RateLimitedError({
      scope: 'login',
      limit: lockout.limit,
      retryAfterMs: lockout.retryAfterMs,
      detail: 'Too many failed logins. Try again later.',
    });
  }

  #auditRefreshFailure(actor: ActorContext, row: RefreshCandidateRow | null, reason: string): void {
    this.#audit(actor, {
      action: 'auth.refresh',
      outcome: 'failure',
      actorId: row?.owner.id ?? null,
      sessionId: row?.sessionId ?? null,
      targetType: 'session',
      targetId: row?.sessionId ?? null,
      details: { reason },
    });
  }

  /** The actor defaults to the request's authenticated user (null on public routes); the event may name another. */
  #audit(actor: ActorContext, event: Omit<AuditEvent, 'requestId' | 'ip' | 'userAgent'>): void {
    this.#deps.audit.record({ ...actorAuditFields(actor), ...event });
  }
}
