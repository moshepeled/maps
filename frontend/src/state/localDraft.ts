/**
 * Local safety net for unsaved work (UX F-02 step 6, C-06.8, C-24; SPEC section 8.6): the in-progress drawing or edit is
 * autosaved per user (300 ms debounce) and offered back after a reload, for 7 days. A cancelled drawing is marked
 * `discardedAt` immediately, so a reload inside the Undo window never offers it back. Never shown to another user.
 */
import type { Position } from '@snapland/shared';
import { z } from 'zod';

import { DRAFT_RETENTION_DAYS } from '../constants/ux';
import { readJson, removeKey, writeJson } from '../lib/storage';

const KEY_PREFIX = 'snapland:draft:';
const RETENTION_MS = DRAFT_RETENTION_DAYS * 24 * 60 * 60 * 1000;

const PositionSchema = z.tuple([z.number(), z.number()]);

const LocalDraftSchema = z.object({
  v: z.literal(1),
  savedAt: z.number(),
  discardedAt: z.number().nullable(),
  kind: z.enum(['drawing', 'naming', 'edit']),
  points: z.array(PositionSchema).max(2000),
  name: z.string().max(2000),
  description: z.string().max(10_000),
  edit: z.object({ areaId: z.string(), name: z.string(), baseVersion: z.number().int() }).nullable(),
});

export type LocalDraft = z.infer<typeof LocalDraftSchema>;

function keyFor(userId: string): string {
  return `${KEY_PREFIX}${userId}`;
}

export function saveLocalDraft(
  userId: string,
  draft: {
    kind: LocalDraft['kind'];
    points: readonly Position[];
    name?: string;
    description?: string;
    edit?: LocalDraft['edit'];
  },
  now: number,
): void {
  const record: LocalDraft = {
    v: 1,
    savedAt: now,
    discardedAt: null,
    kind: draft.kind,
    points: draft.points.map((point): [number, number] => [point[0], point[1]]),
    name: draft.name ?? '',
    description: draft.description ?? '',
    edit: draft.edit ?? null,
  };
  writeJson(keyFor(userId), record);
}

/** The restorable draft of this user, or null (none, discarded, expired or unreadable - the latter are purged). */
export function loadLocalDraft(userId: string, now: number): LocalDraft | null {
  const parsed = LocalDraftSchema.safeParse(readJson(keyFor(userId)));
  if (!parsed.success) return null;
  const draft = parsed.data;
  if (draft.discardedAt !== null || now - draft.savedAt > RETENTION_MS || draft.points.length === 0) {
    if (now - draft.savedAt > RETENTION_MS) removeKey(keyFor(userId));
    return null;
  }
  return draft;
}

/** Cancel with Undo (UX C-06.8): hidden from the restore banner at once, purged when the Undo toast expires. */
export function markLocalDraftDiscarded(userId: string, now: number): void {
  const parsed = LocalDraftSchema.safeParse(readJson(keyFor(userId)));
  if (!parsed.success) return;
  writeJson(keyFor(userId), { ...parsed.data, discardedAt: now });
}

export function clearLocalDraft(userId: string): void {
  removeKey(keyFor(userId));
}

/** Per-user, per-device view preference (UX F-02 step 2, UX-AC-04, UX-AC-48). */
const ViewPrefSchema = z.object({
  center: z.object({ lat: z.number().min(-90).max(90), lng: z.number().min(-540).max(540) }),
  zoom: z.number().min(0).max(22),
  choice: z.enum(['map', 'aerial']),
});

export type ViewPreference = z.infer<typeof ViewPrefSchema>;

export function loadViewPreference(userId: string): ViewPreference | null {
  const parsed = ViewPrefSchema.safeParse(readJson(`snapland:view:${userId}`));
  return parsed.success ? parsed.data : null;
}

export function saveViewPreference(userId: string, preference: ViewPreference): void {
  writeJson(`snapland:view:${userId}`, preference);
}

const DevicePrefsSchema = z.object({ quietMode: z.boolean(), singleKeyShortcuts: z.boolean() });
export type DevicePrefs = z.infer<typeof DevicePrefsSchema>;

export function loadDevicePrefs(): DevicePrefs {
  const parsed = DevicePrefsSchema.safeParse(readJson('snapland:prefs'));
  return parsed.success ? parsed.data : { quietMode: false, singleKeyShortcuts: true };
}

export function saveDevicePrefs(prefs: DevicePrefs): void {
  writeJson('snapland:prefs', prefs);
}
