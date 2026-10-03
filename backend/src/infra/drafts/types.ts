/**
 * Draft ownership registry (SPEC section 3.3, section 7.6). Proves which user/session/connection owns a live draft id, so a
 * `draft.start` cannot hijack another user's draft and a POST /areas cannot squat another user's draft id.
 */

export interface DraftOwner {
  userId: string;
  sessionId: string;
  connectionId: string;
  instanceId: string;
  state: 'active' | 'disconnected';
}

export type DraftClaimResult = 'claimed' | 'in_use';
export type DraftResumeResult = 'resumed' | 'not_found';

export interface DraftRegistry {
  /** SET NX with the resume-window TTL. Any existing record (own or foreign) -> 'in_use'. Throws when Redis fails. */
  claim(draftId: string, owner: Omit<DraftOwner, 'state'>): Promise<DraftClaimResult>;
  /**
   * Takes the record over (new session/connection/instance, state active) iff it exists, belongs to the same user,
   * and either the session matches or the record is `disconnected` (re-login resume, UX F-11). Throws when Redis fails.
   */
  resume(draftId: string, owner: Omit<DraftOwner, 'state'>): Promise<DraftResumeResult>;
  /**
   * Refreshes the TTL if this connection still owns the draft (at most once per `draftTouchIntervalMs(resume window)`
   * per draft, i.e. <= 1 per 10 s; errors are logged).
   */
  touch(draftId: string, connectionId: string): Promise<void>;
  /** Compare connectionId -> DEL. False when not owned (or Redis failed). */
  release(draftId: string, connectionId: string): Promise<boolean>;
  /** Compare connectionId -> state = disconnected, TTL reset to the resume window. False when not owned. */
  markDisconnected(draftId: string, connectionId: string): Promise<boolean>;
  /** Fail-open: null when there is no record or Redis is down. */
  getOwner(draftId: string): Promise<DraftOwner | null>;
}

/** Longest interval between two TTL refreshes of the same draft (section 7.6: touch <= 1 per 10 s). */
export const DRAFT_TOUCH_MIN_INTERVAL_MS = 10_000;

/**
 * The registry's touch throttle for a resume window (the record TTL): 10 s, shortened to a third of the window when that
 * is smaller, so every window sees several refreshes and a draft whose owner keeps drawing never expires between two
 * throttled touches (integration tests run with REALTIME_DRAFT_RESUME_WINDOW_S = 2, section 11.3).
 */
export function draftTouchIntervalMs(resumeWindowS: number): number {
  return Math.min(DRAFT_TOUCH_MIN_INTERVAL_MS, Math.floor((resumeWindowS * 1000) / 3));
}
