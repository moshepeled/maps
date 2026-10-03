/**
 * Client-side area state (SPEC section 7.12 steps 4-5): the areas by id, delete tombstones, the change-feed cursor
 * (`restCursor`) and the region bookkeeping that decides which unknown areas the client must track.
 *
 * Every operation is a pure function over an immutable `AreasState`; `createAreasStore()` wraps them in a zustand
 * store for React. Rules (normative, SPEC section 7.12):
 * - apply an upsert only if `version > max(knownVersion, tombstoneVersion)` - events are idempotent and
 *   order-independent, so "v5 delete, then late v4 update" never resurrects an area;
 * - items for known areas are always applied, even outside the viewport; items for unknown areas only when their
 *   bbox intersects a fetched **or loading** region;
 * - `restCursor` moves only from change-feed pages, never from bbox pages or WebSocket events.
 */
import type { AreaDto, AreaListItemDto, AreaOp, Bbox, Position, UserRef } from '@snapland/shared';
import { bboxContains, bboxesIntersect } from '@snapland/shared';
import { createStore } from 'zustand/vanilla';

import { AREA_STORE_MAX, TOMBSTONE_MAX, TOMBSTONE_TTL_MS } from '../constants/ux';

export interface AreaRecord {
  id: string;
  name: string;
  /** List geometry (possibly simplified) or the full-precision geometry of an `AreaDto`. */
  rings: Position[][];
  bbox: Bbox;
  areaKm2: number;
  version: number;
  changeSeq: number;
  createdById: string;
  /** Known once a full `AreaDto` arrived (detail, event, mutation response). */
  createdBy: UserRef | null;
  updatedBy: UserRef;
  updatedAt: string;
  /** `undefined` = not known yet (list items carry no description). */
  description: string | null | undefined;
  perimeterKm: number | null;
  vertexCount: number | null;
  /** Coordinate decimals of `rings` (7 = full precision). */
  precision: number;
}

export interface Region {
  id: number;
  bbox: Bbox;
  zoom: number;
}

export interface Tombstone {
  version: number;
  at: number;
}

export interface AreasState {
  byId: ReadonlyMap<string, AreaRecord>;
  tombstones: ReadonlyMap<string, Tombstone>;
  /** The `since` of the change feed; null until the first load initialises it. */
  restCursor: number | null;
  fetchedRegions: readonly Region[];
  loadingRegions: readonly Region[];
  /** Bumped on every change of `byId` (cheap change detection for the renderers). */
  revision: number;
}

export const EMPTY_AREAS: AreasState = {
  byId: new Map(),
  tombstones: new Map(),
  restCursor: null,
  fetchedRegions: [],
  loadingRegions: [],
  revision: 0,
};

const FULL_PRECISION = 7;

export function recordFromListItem(item: AreaListItemDto, precision: number): AreaRecord {
  return {
    id: item.id,
    name: item.name,
    rings: item.geometry.coordinates,
    bbox: item.bbox,
    areaKm2: item.areaKm2,
    version: item.version,
    changeSeq: item.changeSeq,
    createdById: item.createdById,
    createdBy: null,
    updatedBy: item.updatedBy,
    updatedAt: item.updatedAt,
    description: undefined,
    perimeterKm: null,
    vertexCount: null,
    precision,
  };
}

export function recordFromDto(area: AreaDto): AreaRecord {
  return {
    id: area.id,
    name: area.name,
    rings: area.geometry.coordinates,
    bbox: area.bbox,
    areaKm2: area.areaKm2,
    version: area.version,
    changeSeq: area.changeSeq,
    createdById: area.createdBy.id,
    createdBy: area.createdBy,
    updatedBy: area.updatedBy,
    updatedAt: area.updatedAt,
    description: area.description,
    perimeterKm: area.perimeterKm,
    vertexCount: area.vertexCount,
    precision: FULL_PRECISION,
  };
}

function regionsIntersect(regions: readonly Region[], bbox: Bbox): boolean {
  return regions.some((region) => bboxesIntersect(region.bbox, bbox));
}

/** Is an unknown area with this bbox inside the part of the world the client tracks (fetched ∪ loading)? */
export function isTracked(state: AreasState, bbox: Bbox): boolean {
  return regionsIntersect(state.fetchedRegions, bbox) || regionsIntersect(state.loadingRegions, bbox);
}

function highestKnownVersion(state: AreasState, id: string): number {
  const known = state.byId.get(id)?.version ?? 0;
  const tombstone = state.tombstones.get(id)?.version ?? 0;
  return Math.max(known, tombstone);
}

/** Same version, better geometry: a list item at a finer LOD, or the full-precision DTO. */
function upgradesGeometry(existing: AreaRecord | undefined, incoming: AreaRecord): boolean {
  if (existing?.version !== incoming.version) return false;
  return (
    incoming.precision > existing.precision || (incoming.createdBy !== null && existing.createdBy === null)
  );
}

function mergeRecords(existing: AreaRecord | undefined, incoming: AreaRecord): AreaRecord {
  if (existing?.version !== incoming.version) return incoming;
  // Equal versions describe the same content: keep whatever detail either side already carries.
  return {
    ...incoming,
    createdBy: incoming.createdBy ?? existing.createdBy,
    description: incoming.description !== undefined ? incoming.description : existing.description,
    perimeterKm: incoming.perimeterKm ?? existing.perimeterKm,
    vertexCount: incoming.vertexCount ?? existing.vertexCount,
    rings: incoming.precision >= existing.precision ? incoming.rings : existing.rings,
    precision: Math.max(incoming.precision, existing.precision),
  };
}

function withAreas(
  state: AreasState,
  byId: Map<string, AreaRecord>,
  tombstones = state.tombstones,
): AreasState {
  return { ...state, byId, tombstones, revision: state.revision + 1 };
}

function pruneTombstones(tombstones: Map<string, Tombstone>, now: number): void {
  for (const [id, tombstone] of tombstones) {
    if (now - tombstone.at > TOMBSTONE_TTL_MS) tombstones.delete(id);
  }
  // Bounded (SPEC section 7.12 step 5): drop the oldest first (Map iteration is insertion order).
  while (tombstones.size > TOMBSTONE_MAX) {
    const oldest = tombstones.keys().next();
    if (oldest.done === true) break;
    tombstones.delete(oldest.value);
  }
}

/**
 * Applies the items of one bbox page. Pages describe the state as of their `asOfChangeSeq`, so the version rule keeps
 * newer knowledge (WS events, tombstones) intact. Pages never touch `restCursor`.
 */
export function applyListPage(
  state: AreasState,
  items: readonly AreaListItemDto[],
  precision: number,
): AreasState {
  let byId: Map<string, AreaRecord> | null = null;
  for (const item of items) {
    const incoming = recordFromListItem(item, precision);
    const existing = (byId ?? state.byId).get(item.id);
    if (incoming.version > highestKnownVersion(state, item.id) || upgradesGeometry(existing, incoming)) {
      byId ??= new Map(state.byId);
      byId.set(item.id, mergeRecords(existing, incoming));
    }
  }
  return byId === null ? state : withAreas(state, byId);
}

export interface ChangeLike {
  op: AreaOp;
  area: AreaDto;
}

export type ChangeOutcome = 'upserted' | 'deleted' | 'stale' | 'dropped';

export interface ApplyChangeOptions {
  /**
   * This client asked for the area itself - the response to my own save, edit, rename, delete or restore, or a
   * detail read. It is applied even outside every tracked region (e.g. the bounds load failed, or I saved before any
   * region finished loading): the drop rule is for feed items and WS events about areas nobody here is looking at.
   * The version and tombstone rules still apply.
   */
  requested?: boolean;
}

/**
 * Applies one committed change (WS `area.changed`, feed item, or a mutation response): known ids always, unknown ids
 * only inside tracked regions (or when `requested`); deletes leave a tombstone so older events cannot resurrect the
 * area.
 */
export function applyChange(
  state: AreasState,
  change: ChangeLike,
  now: number,
  options: ApplyChangeOptions = {},
): { state: AreasState; outcome: ChangeOutcome } {
  const { area } = change;
  const known = state.byId.has(area.id);
  if (!known && options.requested !== true && !isTracked(state, area.bbox))
    return { state, outcome: 'dropped' };
  const isDelete = change.op === 'delete' || area.deletedAt !== null;
  const incoming = recordFromDto(area);
  const existing = state.byId.get(area.id);
  if (
    area.version <= highestKnownVersion(state, area.id) &&
    !(isDelete ? false : upgradesGeometry(existing, incoming))
  ) {
    return { state, outcome: 'stale' };
  }
  const byId = new Map(state.byId);
  const tombstones = new Map(state.tombstones);
  if (isDelete) {
    byId.delete(area.id);
    tombstones.set(area.id, { version: area.version, at: now });
    pruneTombstones(tombstones, now);
    return { state: withAreas(state, byId, tombstones), outcome: 'deleted' };
  }
  byId.set(area.id, mergeRecords(existing, incoming));
  // A restore (or any newer live version) supersedes the tombstone.
  tombstones.delete(area.id);
  return { state: withAreas(state, byId, tombstones), outcome: 'upserted' };
}

/** Removes an area that no longer exists anywhere (404 after `includeDeleted`, UX C-11). */
export function removeArea(state: AreasState, id: string, now: number): AreasState {
  if (!state.byId.has(id)) return state;
  const byId = new Map(state.byId);
  const removed = byId.get(id);
  byId.delete(id);
  const tombstones = new Map(state.tombstones);
  if (removed !== undefined) tombstones.set(id, { version: removed.version, at: now });
  return withAreas(state, byId, tombstones);
}

/** Registers a region as loading before its first page is requested (SPEC section 7.12 step 4). */
export function beginRegion(state: AreasState, region: Region): AreasState {
  return { ...state, loadingRegions: [...state.loadingRegions, region] };
}

/** Drops a loading region whose load was abandoned (aborted or failed) without marking it fetched. */
export function abandonRegion(state: AreasState, regionId: number): AreasState {
  return { ...state, loadingRegions: state.loadingRegions.filter((region) => region.id !== regionId) };
}

/** After the catch-up: the region becomes fetched and `restCursor <- max(restCursor, feedCursor)`. */
export function completeRegion(state: AreasState, regionId: number, feedCursor: number): AreasState {
  const region = state.loadingRegions.find((candidate) => candidate.id === regionId);
  if (region === undefined) return state;
  return {
    ...state,
    loadingRegions: state.loadingRegions.filter((candidate) => candidate.id !== regionId),
    fetchedRegions: [...state.fetchedRegions.filter((candidate) => candidate.id !== regionId), region],
    restCursor: state.restCursor === null ? feedCursor : Math.max(state.restCursor, feedCursor),
  };
}

/** Change-feed pages are the only source that moves the cursor forward. */
export function advanceRestCursor(state: AreasState, nextSince: number): AreasState {
  if (state.restCursor !== null && nextSince <= state.restCursor) return state;
  return { ...state, restCursor: nextSince };
}

/** First load on an empty store (or after a 410 reload): the cursor starts at the load's `minAsOf`. */
export function initialiseRestCursor(state: AreasState, minAsOf: number): AreasState {
  return state.restCursor === null ? { ...state, restCursor: minAsOf } : state;
}

/** A fetched region at the same zoom that contains `bbox` makes a new request unnecessary. */
export function isCovered(state: AreasState, bbox: Bbox, zoom: number): boolean {
  return state.fetchedRegions.some((region) => region.zoom === zoom && bboxContains(region.bbox, bbox));
}

function bboxCentre(bbox: Bbox): { lng: number; lat: number } {
  return { lng: (bbox[0] + bbox[2]) / 2, lat: (bbox[1] + bbox[3]) / 2 };
}

/**
 * Bounds memory (SPEC section 7.12 step 4): above `max` areas, the farthest from the viewport centre are evicted, and every
 * fetched region that intersected an evicted area is forgotten, so panning back over it refetches instead of trusting
 * a region that is no longer complete in memory.
 */
export function evictIfNeeded(
  state: AreasState,
  centre: { lng: number; lat: number },
  max: number = AREA_STORE_MAX,
): AreasState {
  const excess = state.byId.size - max;
  if (excess <= 0) return state;
  const byDistance = [...state.byId.values()]
    .map((area) => {
      const c = bboxCentre(area.bbox);
      return { area, distance: (c.lng - centre.lng) ** 2 + (c.lat - centre.lat) ** 2 };
    })
    .sort((left, right) => right.distance - left.distance);
  const evicted = byDistance.slice(0, excess).map((entry) => entry.area);
  const byId = new Map(state.byId);
  for (const area of evicted) byId.delete(area.id);
  const fetchedRegions = state.fetchedRegions.filter(
    (region) => !evicted.some((area) => bboxesIntersect(region.bbox, area.bbox)),
  );
  return { ...withAreas(state, byId), fetchedRegions };
}

/**
 * The 410 / feed-overflow reload (SPEC section 7.12 step 4): areas outside the reloaded viewport have an unknown state, so
 * they are evicted; the region bookkeeping and the cursor start over (the next region load re-initialises both).
 */
export function resetForReload(state: AreasState, keep: readonly Bbox[]): AreasState {
  const byId = new Map<string, AreaRecord>();
  for (const [id, area] of state.byId) {
    if (keep.some((bbox) => bboxesIntersect(bbox, area.bbox))) byId.set(id, area);
  }
  return {
    ...withAreas(state, byId),
    fetchedRegions: [],
    loadingRegions: [],
    restCursor: null,
  };
}

// -- zustand wrapper -------------------------------------------------------------------------

export interface AreasStore extends AreasState {
  update(transform: (state: AreasState) => AreasState): void;
  reset(): void;
}

function stateOf(store: AreasStore): AreasState {
  return {
    byId: store.byId,
    tombstones: store.tombstones,
    restCursor: store.restCursor,
    fetchedRegions: store.fetchedRegions,
    loadingRegions: store.loadingRegions,
    revision: store.revision,
  };
}

export function createAreasStore(initial: AreasState = EMPTY_AREAS) {
  return createStore<AreasStore>()((set, get) => ({
    ...initial,
    update: (transform) => {
      const current = stateOf(get());
      const next = transform(current);
      if (next !== current) set(next);
    },
    reset: () => {
      set({ ...EMPTY_AREAS, revision: get().revision + 1 });
    },
  }));
}

export type AreasStoreApi = ReturnType<typeof createAreasStore>;

export function currentAreasState(store: AreasStoreApi): AreasState {
  return stateOf(store.getState());
}
