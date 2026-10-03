/** PostgreSQL implementations of the read ports (SPEC section 3.3). Invalid ids are answered as "absent", never as a DB error. */
import type { Bbox } from '@snapland/shared';

import type { Db } from '../db/types.js';
import { DIRECTORY_SQL } from './queries.js';
import type { ActiveSessionRow, AreaBboxRow, LatestChangeSeqRow, UserProfileRow } from './queries.js';
import type { ActiveSession, AreaReader, SessionReader, UserDirectory, UserProfile } from './types.js';

/** Upper bound of ids per `= ANY($1)` statement. */
const MAX_IDS_PER_STATEMENT = 500;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function validUuids(ids: readonly string[]): string[] {
  return [...new Set(ids.filter((id) => UUID.test(id)))];
}

function chunks<T>(items: readonly T[], size: number): T[][] {
  const result: T[][] = [];
  for (let start = 0; start < items.length; start += size) result.push(items.slice(start, start + size));
  return result;
}

function toActiveSession(row: ActiveSessionRow): ActiveSession {
  return {
    sessionId: row.session_id,
    userId: row.user_id,
    role: row.role,
    absoluteExpiresAt: row.absolute_expires_at,
    expiresAt: row.expires_at,
  };
}

function toProfile(row: UserProfileRow): UserProfile {
  return {
    id: row.id,
    displayName: row.display_name,
    color: row.color,
    role: row.role,
    disabled: row.disabled,
  };
}

export function createSessionReader(db: Db): SessionReader {
  return {
    async getActive(sessionId) {
      if (!UUID.test(sessionId)) return null;
      const [row] = await db.query<ActiveSessionRow>(DIRECTORY_SQL.activeSession, [sessionId]);
      return row === undefined ? null : toActiveSession(row);
    },
    async getActiveMany(sessionIds) {
      const active = new Map<string, ActiveSession>();
      for (const batch of chunks(validUuids(sessionIds), MAX_IDS_PER_STATEMENT)) {
        const rows = await db.query<ActiveSessionRow>(DIRECTORY_SQL.activeSessions, [batch]);
        for (const row of rows) active.set(row.session_id, toActiveSession(row));
      }
      return active;
    },
  };
}

export function createUserDirectory(db: Db): UserDirectory {
  return {
    async getProfiles(ids) {
      const profiles = new Map<string, UserProfile>();
      for (const batch of chunks(validUuids(ids), MAX_IDS_PER_STATEMENT)) {
        const rows = await db.query<UserProfileRow>(DIRECTORY_SQL.userProfiles, [batch]);
        for (const row of rows) profiles.set(row.id, toProfile(row));
      }
      return profiles;
    },
  };
}

export function createAreaReader(db: Db): AreaReader {
  return {
    async getBbox(areaId) {
      if (!UUID.test(areaId)) return null;
      const [row] = await db.query<AreaBboxRow>(DIRECTORY_SQL.areaBbox, [areaId]);
      if (row === undefined) return null;
      const bbox: Bbox = [row.west, row.south, row.east, row.north];
      return bbox;
    },
    async latestChangeSeq() {
      const [row] = await db.query<LatestChangeSeqRow>(DIRECTORY_SQL.latestChangeSeq);
      return row?.latest ?? 0;
    },
  };
}
