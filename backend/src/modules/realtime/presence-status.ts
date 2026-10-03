/**
 * Server-side presence status derivation (SPEC section 7.7, v1.2 precedence, resolves UX SG-26). First match wins:
 *  1. `editing` - the connection has an active draft with a non-null `areaId` (a reshaping edit, lockless "Edit anyway"
 *     included), or holds a soft lock; `activeAreaId` = the draft's `areaId` if any, else the most recently acquired
 *     lock's area;
 *  2. `drawing` - an active draft for a new area (`areaId = null`); `activeAreaId` = the draft id;
 *  3. otherwise the client-reported `viewing` / `idle`.
 */
import type { PresenceStatus } from '@snapland/shared';

export type ReportedStatus = 'viewing' | 'idle';

export interface PresenceStatusInput {
  reported: ReportedStatus;
  draft: { draftId: string; areaId: string | null } | null;
  /** Areas locked by the connection, oldest acquisition first. */
  lockedAreaIds: readonly string[];
}

export interface DerivedStatus {
  status: PresenceStatus;
  activeAreaId: string | null;
}

export function derivePresenceStatus({ reported, draft, lockedAreaIds }: PresenceStatusInput): DerivedStatus {
  const draftAreaId = draft?.areaId ?? null;
  if (draftAreaId !== null) return { status: 'editing', activeAreaId: draftAreaId };
  const newestLock = lockedAreaIds.at(-1);
  if (newestLock !== undefined) return { status: 'editing', activeAreaId: newestLock };
  if (draft !== null) return { status: 'drawing', activeAreaId: draft.draftId };
  return { status: reported, activeAreaId: null };
}
