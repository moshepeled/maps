/**
 * The refresh-token rotation decision (SPEC section 6.2 rules 1-3) as a pure function of the session row locked by
 * `SELECT ... FOR UPDATE` and the database time of that transaction. A revoked session, or one whose user is disabled,
 * answers SESSION_REVOKED whichever token matched.
 */

/** A rotation this recent explains a replay of the previous token by another tab (section 6.2 rule 2). */
export const REFRESH_RACE_WINDOW_MS = 10_000;

export interface RefreshCandidate {
  /** Which hash of the session the presented token matched. */
  matched: 'current' | 'previous';
  revoked: boolean;
  userDisabled: boolean;
  /** Sliding expiry. */
  expiresAt: Date;
  /** Never extended. */
  absoluteExpiresAt: Date;
  /** When the current token replaced the previous one (null before the first rotation). */
  rotatedAt: Date | null;
}

export type RotationRejection =
  | { kind: 'reject'; code: 'REFRESH_TOKEN_INVALID'; reason: 'unknown' | 'expired' | 'race' }
  | { kind: 'reject'; code: 'SESSION_REVOKED'; reason: 'revoked' | 'disabled' };

export type RotationDecision = { kind: 'rotate'; expiresAt: Date } | { kind: 'reuse' } | RotationRejection;

/** The sliding expiry after a successful refresh: `min(now + ttl, absoluteExpiresAt)`. */
export function slidingExpiry(now: Date, refreshTtlS: number, absoluteExpiresAt: Date): Date {
  const sliding = now.getTime() + refreshTtlS * 1000;
  return new Date(Math.min(sliding, absoluteExpiresAt.getTime()));
}

function isExpired(candidate: RefreshCandidate, now: Date): boolean {
  const nowMs = now.getTime();
  return nowMs >= candidate.expiresAt.getTime() || nowMs >= candidate.absoluteExpiresAt.getTime();
}

function isWithinRaceWindow(rotatedAt: Date | null, now: Date): boolean {
  // Without a rotation time there is no race that could explain the replay.
  return rotatedAt !== null && now.getTime() - rotatedAt.getTime() <= REFRESH_RACE_WINDOW_MS;
}

/**
 * Rule 1: the current token of a live session rotates with the sliding expiry. Rule 2: the previous token is a
 * parallel-tab race within 10 s of the rotation (nothing revoked), a replayed token later (the caller revokes).
 * `now` is the database time of the transaction.
 */
export function decideRotation(
  candidate: RefreshCandidate,
  now: Date,
  refreshTtlS: number,
): RotationDecision {
  if (candidate.revoked) return { kind: 'reject', code: 'SESSION_REVOKED', reason: 'revoked' };
  if (candidate.userDisabled) return { kind: 'reject', code: 'SESSION_REVOKED', reason: 'disabled' };

  if (candidate.matched === 'previous') {
    return isWithinRaceWindow(candidate.rotatedAt, now)
      ? { kind: 'reject', code: 'REFRESH_TOKEN_INVALID', reason: 'race' }
      : { kind: 'reuse' };
  }

  if (isExpired(candidate, now)) return { kind: 'reject', code: 'REFRESH_TOKEN_INVALID', reason: 'expired' };
  return { kind: 'rotate', expiresAt: slidingExpiry(now, refreshTtlS, candidate.absoluteExpiresAt) };
}
