/**
 * Narrow cross-module read ports (SPEC section 3.2, section 3.3): modules never query another module's tables. Realtime reads
 * session validity, user profiles and area bboxes through these; the statements live in `queries.ts`.
 */
import type { Bbox } from '@snapland/shared';

export interface ActiveSession {
  sessionId: string;
  userId: string;
  role: 'user' | 'admin';
  absoluteExpiresAt: Date;
  expiresAt: Date;
}

export interface SessionReader {
  /** Returns the session only if it is active (section 0 "Active session") and its user is not disabled; otherwise null. */
  getActive(sessionId: string): Promise<ActiveSession | null>;
  /**
   * Batch form for the WS re-validation loop (section 7.2 step 5): one statement `WHERE s.id = ANY($1)` per call of <= 500
   * ids (larger inputs are split). The map contains only the sessions that are still active. Throws on DB errors
   * (the caller skips that round).
   */
  getActiveMany(sessionIds: readonly string[]): Promise<Map<string, ActiveSession>>;
}

export interface UserProfile {
  id: string;
  displayName: string;
  color: string;
  role: 'user' | 'admin';
  disabled: boolean;
}

export interface UserDirectory {
  /** Current profiles (<= 500 ids per statement); unknown ids are absent from the map. */
  getProfiles(ids: readonly string[]): Promise<Map<string, UserProfile>>;
}

export interface AreaReader {
  /** bbox of a live (not soft-deleted) area, else null. */
  getBbox(areaId: string): Promise<Bbox | null>;
  /** GREATEST(max(area_versions.change_seq), change_feed_purge_watermark) - the single definition used by REST and WS. */
  latestChangeSeq(): Promise<number>;
}
