import type { AreaDto, Bbox, ChangeEventDto } from '@snapland/shared';
import { bboxesIntersect } from '@snapland/shared';
import { describe, expect, it } from 'vitest';

import { systemScheduler } from '../lib/scheduler';
import type { AreaInput } from '../test/factories';
import { areaDto, bboxOf, changeEvent, listItem, uuid } from '../test/factories';
import type { AreasState } from './areasStore';
import {
  EMPTY_AREAS,
  applyChange,
  applyListPage,
  beginRegion,
  completeRegion,
  createAreasStore,
  currentAreasState,
  evictIfNeeded,
  isCovered,
  removeArea,
} from './areasStore';
import type { AreasSyncApi, ListPage } from './areasSync';
import { AreasSync, FeedExpiredError } from './areasSync';

const NOW = 1_790_000_000_000;
const REGION_A: Bbox = [34.7, 32.0, 34.9, 32.2];
const REGION_B: Bbox = [35.1, 31.7, 35.3, 31.9];

/** An in-memory server with keyset pagination by id, a change feed and a purge watermark. */
class FakeAreasServer implements AreasSyncApi {
  readonly live = new Map<string, AreaDto>();
  readonly log: ChangeEventDto[] = [];
  seq = 100;
  watermark = 0;
  pageSize = 2;
  pagesServed = 0;
  /** Runs before page N (1-based) is answered: lets a test commit changes mid-pagination. */
  beforePage: ((page: number) => void) | null = null;
  /** Replaces the answer of the first page (a stale cached page). */
  stalePage: ListPage | null = null;

  commit(input: AreaInput & { op?: ChangeEventDto['op'] }): ChangeEventDto {
    this.seq += 1;
    const event = changeEvent({ ...input, changeSeq: this.seq });
    this.log.push(event);
    if (event.area.deletedAt === null) this.live.set(event.areaId, event.area);
    else this.live.delete(event.areaId);
    return event;
  }

  listBbox(params: { bbox: Bbox; zoom: number; limit: number; cursor: string | null }): Promise<ListPage> {
    this.pagesServed += 1;
    const page = this.pagesServed;
    this.beforePage?.(page);
    if (page === 1 && this.stalePage !== null) return Promise.resolve(this.stalePage);
    const matching = [...this.live.values()]
      .filter((area) => bboxesIntersect(area.bbox, params.bbox))
      .filter((area) => params.cursor === null || area.id > params.cursor)
      .sort((left, right) => left.id.localeCompare(right.id));
    const items = matching.slice(0, this.pageSize);
    const more = matching.length > this.pageSize;
    return Promise.resolve({
      items: items.map((area) =>
        listItem({
          id: area.id,
          version: area.version,
          changeSeq: area.changeSeq,
          west: area.bbox[0],
          south: area.bbox[1],
          size: area.bbox[2] - area.bbox[0],
        }),
      ),
      nextCursor: more ? (items.at(-1)?.id ?? null) : null,
      asOfChangeSeq: this.seq,
      simplified: true,
      precision: 6,
      zoom: params.zoom,
      queryBbox: params.bbox,
      minExtentDeg: 0,
      culledCount: params.cursor === null ? 3 : null,
      bytes: 100,
    });
  }

  changes(params: {
    since: number;
    limit: number;
  }): Promise<{ items: ChangeEventDto[]; nextSince: number; hasMore: boolean; latestChangeSeq: number }> {
    if (params.since < this.watermark) return Promise.reject(new FeedExpiredError());
    const pending = this.log.filter((event) => event.changeSeq > params.since);
    const items = pending.slice(0, params.limit);
    return Promise.resolve({
      items,
      nextSince: items.at(-1)?.changeSeq ?? params.since,
      hasMore: pending.length > items.length,
      latestChangeSeq: this.seq,
    });
  }
}

function setup(viewport: Bbox[] = [REGION_A]) {
  const store = createAreasStore();
  const server = new FakeAreasServer();
  const sync = new AreasSync({
    store,
    api: server,
    scheduler: systemScheduler,
    viewport: () => ({ parts: viewport, zoom: 14, centre: { lng: 34.8, lat: 32.1 } }),
  });
  const signal = new AbortController().signal;
  return { store, server, sync, signal, state: () => currentAreasState(store) };
}

function inside(n: number, west = 34.75, south = 32.05): AreaInput {
  return { id: uuid(n), west, south, size: 0.001 };
}

describe('areasStore - version rule and tombstones (SPEC section 7.12 step 5)', () => {
  it('delete v5 then a late update v4 is ignored; a restore v6 clears the tombstone', () => {
    const id = uuid(1);
    let state: AreasState = applyChange(
      EMPTY_AREAS,
      { op: 'create', area: areaDto({ id, version: 3 }) },
      NOW,
    ).state;
    state = beginRegion(state, { id: 1, bbox: REGION_A, zoom: 14 });
    state = applyChange(state, { op: 'delete', area: areaDto({ id, version: 5, deleted: true }) }, NOW).state;
    expect(state.byId.has(id)).toBe(false);
    expect(state.tombstones.get(id)?.version).toBe(5);
    const late = applyChange(state, { op: 'update', area: areaDto({ id, version: 4 }) }, NOW);
    expect(late.outcome).toBe('stale');
    expect(late.state.byId.has(id)).toBe(false);
    const restored = applyChange(late.state, { op: 'restore', area: areaDto({ id, version: 6 }) }, NOW);
    expect(restored.outcome).toBe('upserted');
    expect(restored.state.byId.get(id)?.version).toBe(6);
    expect(restored.state.tombstones.has(id)).toBe(false);
  });

  it('bbox pages keep newer knowledge and never touch restCursor', () => {
    const id = uuid(2);
    let state: AreasState = { ...EMPTY_AREAS, restCursor: 100 };
    state = applyListPage(state, [listItem({ id, version: 2 })], 5);
    expect(state.byId.get(id)?.version).toBe(2);
    state = applyListPage(state, [listItem({ id, version: 1 })], 5);
    expect(state.byId.get(id)?.version).toBe(2);
    // Same version at a finer LOD upgrades the geometry only.
    state = applyListPage(state, [listItem({ id, version: 2 })], 7);
    expect(state.byId.get(id)?.precision).toBe(7);
    expect(state.restCursor).toBe(100);
  });

  it('a full AreaDto of the same version adds the detail (creator, description) without a version bump', () => {
    const id = uuid(3);
    let state = applyListPage({ ...EMPTY_AREAS }, [listItem({ id, version: 1 })], 5);
    state = applyChange(state, { op: 'update', area: areaDto({ id, version: 1 }) }, NOW).state;
    expect(state.byId.get(id)?.createdBy?.displayName).toBe('Alice');
    expect(state.byId.get(id)?.precision).toBe(7);
    expect(removeArea(state, id, NOW).byId.has(id)).toBe(false);
  });

  it('an unknown-area item inside a loading region is applied; outside every region it is dropped', () => {
    let state = beginRegion(EMPTY_AREAS, { id: 7, bbox: REGION_A, zoom: 14 });
    const insideResult = applyChange(
      state,
      { op: 'create', area: areaDto({ id: uuid(4), west: 34.8, south: 32.1 }) },
      NOW,
    );
    expect(insideResult.outcome).toBe('upserted');
    state = insideResult.state;
    const outsideResult = applyChange(
      state,
      { op: 'create', area: areaDto({ id: uuid(5), west: 10, south: 10 }) },
      NOW,
    );
    expect(outsideResult.outcome).toBe('dropped');
    // Known areas are always applied, even far outside every region.
    const moved = applyChange(
      state,
      { op: 'update', area: areaDto({ id: uuid(4), version: 2, west: 10, south: 10 }) },
      NOW,
    );
    expect(moved.outcome).toBe('upserted');
  });

  it('a requested area (my own write, a detail read) is applied outside every region; versions still rule', () => {
    const mine = areaDto({ id: uuid(6), west: 10, south: 10, version: 3 });
    const applied = applyChange(EMPTY_AREAS, { op: 'create', area: mine }, NOW, { requested: true });
    expect(applied.outcome).toBe('upserted');
    expect(applied.state.byId.get(mine.id)?.version).toBe(3);
    const older = applyChange(applied.state, { op: 'update', area: { ...mine, version: 2 } }, NOW, {
      requested: true,
    });
    expect(older.outcome).toBe('stale');
    const deleted = applyChange(
      EMPTY_AREAS,
      { op: 'delete', area: { ...mine, deletedAt: '2026-09-27T10:00:00.000Z' } },
      NOW,
      { requested: true },
    );
    expect(deleted.outcome).toBe('deleted');
    expect(deleted.state.tombstones.get(mine.id)?.version).toBe(3);
  });

  it('completeRegion moves the region to fetched and restCursor to max(restCursor, feed cursor)', () => {
    let state: AreasState = {
      ...beginRegion(EMPTY_AREAS, { id: 1, bbox: REGION_A, zoom: 14 }),
      restCursor: 120,
    };
    state = completeRegion(state, 1, 110);
    expect(state.restCursor).toBe(120);
    expect(state.fetchedRegions).toHaveLength(1);
    expect(state.loadingRegions).toHaveLength(0);
    expect(isCovered(state, [34.75, 32.05, 34.8, 32.1], 14)).toBe(true);
    expect(isCovered(state, [34.75, 32.05, 34.8, 32.1], 15)).toBe(false);
  });
});

describe('areasStore - region loading and the catch-up (SPEC section 7.12 step 4)', () => {
  it('an area created mid-pagination with an id below the page cursor appears via the catch-up in limited mode with no WS', async () => {
    const { server, sync, signal, state } = setup();
    for (const n of [10, 20, 30, 40]) server.commit(inside(n));
    server.beforePage = (page) => {
      if (page === 2) server.commit(inside(15)); // id below the cursor (...14): on no page
    };
    const result = await sync.loadRegion(REGION_A, 14, signal);
    expect(result.pages).toBe(2);
    expect(state().byId.has(uuid(15))).toBe(true);
    expect(state().fetchedRegions).toHaveLength(1);
    expect(state().restCursor).toBe(server.seq);
    expect(result.culledCount).toBe(3);
  });

  it('a stale cached page (asOf < restCursor) missing a moved-in area is repaired by the catch-up from min(restCursor, asOf)', async () => {
    const { store, server, sync, signal, state } = setup();
    const movedId = uuid(50);
    server.commit({ ...inside(50), west: 10, south: 10 }); // created far away (seq 101)
    server.commit(inside(51)); // seq 102
    const staleAsOf = server.seq; // 102
    server.commit({ ...inside(50), version: 2 }); // seq 103: moves into region A
    // The client pulled the feed while not tracking region A and dropped seq 103 as "unknown elsewhere".
    store.getState().update((current) => ({ ...current, restCursor: 110 }));
    server.seq = 110;
    server.stalePage = {
      items: [listItem(inside(51))],
      nextCursor: null,
      asOfChangeSeq: staleAsOf,
      simplified: true,
      precision: 6,
      zoom: 14,
      queryBbox: REGION_A,
      minExtentDeg: 0,
      culledCount: 0,
      bytes: 10,
    };
    await sync.loadRegion(REGION_A, 14, signal);
    expect(state().byId.get(movedId)?.version).toBe(2);
    expect(state().restCursor).toBe(110);
  });

  it('bbox pages never advance restCursor; a change to an in-store area outside the viewport arrives via the feed after a pan', async () => {
    const { server, sync, signal, state } = setup();
    server.commit(inside(60));
    await sync.loadRegion(REGION_A, 14, signal);
    const cursorAfterLoad = state().restCursor;
    expect(cursorAfterLoad).toBe(server.seq);
    // More pages elsewhere never move the cursor (only feed pages do).
    server.commit({ ...inside(61), west: 35.2, south: 31.8 });
    const seqBeforeRegionB = server.seq;
    server.log.length = 0; // simulate: the feed has nothing new beyond the cursor for region B's catch-up
    await sync.loadRegion(REGION_B, 14, signal);
    expect(state().restCursor).toBe(cursorAfterLoad);
    expect(seqBeforeRegionB).toBeGreaterThan(cursorAfterLoad ?? 0);
    // The user panned to B; an area of A (known, now out of view) changes: applied from the feed.
    server.commit({ ...inside(60), version: 2, west: 0, south: 0 });
    expect(await sync.pullFeed(signal)).toBe('ok');
    expect(state().byId.get(uuid(60))?.version).toBe(2);
    expect(state().restCursor).toBe(server.seq);
  });

  it('410 CHANGE_FEED_EXPIRED reloads the viewport and evicts every area outside the reloaded region', async () => {
    const { server, sync, signal, state } = setup([REGION_B]);
    server.commit(inside(70));
    server.commit({ ...inside(71), west: 35.2, south: 31.8 });
    await sync.loadRegion(REGION_A, 14, signal);
    await sync.loadRegion(REGION_B, 14, signal);
    expect(state().byId.size).toBe(2);
    server.watermark = server.seq + 5;
    server.seq = server.watermark;
    server.log.length = 0;
    expect(await sync.pullFeed(signal)).toBe('reload');
    expect(state().byId.has(uuid(70))).toBe(false);
    expect(state().byId.has(uuid(71))).toBe(true);
    expect(state().fetchedRegions.map((region) => region.bbox)).toEqual([REGION_B]);
    expect(state().restCursor).toBe(server.seq);
  });

  it('page 10 with a next cursor is reported as truncated and no 11th page is requested', async () => {
    const { server, sync, signal } = setup();
    server.pageSize = 1;
    for (let n = 100; n < 112; n += 1) server.commit(inside(n));
    const result = await sync.loadRegion(REGION_A, 14, signal);
    expect(result.pages).toBe(10);
    expect(result.truncated).toBe(true);
    expect(server.pagesServed).toBe(10);
  });

  it('a failed page abandons the loading region (it never becomes fetched)', async () => {
    const { server, sync, signal, state } = setup();
    server.commit(inside(80));
    server.beforePage = () => {
      throw new Error('network');
    };
    await expect(sync.loadRegion(REGION_A, 14, signal)).rejects.toThrow('network');
    expect(state().loadingRegions).toHaveLength(0);
    expect(state().fetchedRegions).toHaveLength(0);
  });
});

describe('areasStore - eviction (SPEC section 7.12 step 4)', () => {
  it('eviction removes the fetched regions containing evicted areas, and panning back refetches', async () => {
    const { store, server, sync, signal, state } = setup();
    server.commit(inside(90, 34.71, 32.01));
    server.commit(inside(91, 34.72, 32.02));
    server.commit({ ...inside(92), west: 35.2, south: 31.8 });
    await sync.loadRegion(REGION_A, 14, signal);
    await sync.loadRegion(REGION_B, 14, signal);
    expect(isCovered(state(), REGION_A, 14)).toBe(true);
    // Viewport centre over B; the store may keep 1 area: both areas of A go, and so does region A's bookkeeping.
    store.getState().update((current) => evictIfNeeded(current, { lng: 35.2, lat: 31.8 }, 1));
    expect(state().byId.size).toBe(1);
    expect(state().byId.has(uuid(92))).toBe(true);
    expect(isCovered(state(), REGION_A, 14)).toBe(false);
    expect(isCovered(state(), REGION_B, 14)).toBe(true);
    const served = server.pagesServed;
    await sync.loadRegion(REGION_A, 14, signal);
    expect(server.pagesServed).toBeGreaterThan(served);
    expect(state().byId.has(uuid(90))).toBe(true);
  });

  it('a store under the limit is left alone', () => {
    const state = applyListPage(EMPTY_AREAS, [listItem({ id: uuid(95) })], 6);
    expect(evictIfNeeded(state, { lng: 0, lat: 0 }, 10)).toBe(state);
  });

  it('bboxOf helper sanity', () => {
    expect(bboxOf(1, 2, 3)).toEqual([1, 2, 4, 5]);
  });
});
