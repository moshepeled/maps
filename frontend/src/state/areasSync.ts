/**
 * The data-sync engine of the areas store (SPEC section 7.12 step 4, section 8.6 "Bbox loading"): region loads with pagination and
 * the catch-up that closes their holes, change-feed pulls (resync, 60 s anti-entropy, 5 s limited-mode polling) and
 * the 410 / overflow reload. All network access goes through the injected `AreasSyncApi`; all state changes through
 * the pure functions of `areasStore.ts`.
 */
import type { AreaListResponse, Bbox, ChangeFeedResponse } from '@snapland/shared';

import {
  BBOX_MAX_PAGES,
  BBOX_PAGE_LIMIT,
  CHANGE_FEED_MAX_PAGES,
  CHANGE_FEED_PAGE_LIMIT,
} from '../constants/ux';
import type { Scheduler } from '../lib/scheduler';
import type { AreasStoreApi, ChangeLike, Region } from './areasStore';
import {
  abandonRegion,
  advanceRestCursor,
  applyChange,
  applyListPage,
  beginRegion,
  completeRegion,
  currentAreasState,
  evictIfNeeded,
  initialiseRestCursor,
  resetForReload,
} from './areasStore';

export interface ListPage extends AreaListResponse {
  /** Response size in bytes (region-load benchmark, `__snapland.perf`). */
  bytes: number;
}

export interface AreasSyncApi {
  listBbox(
    params: { bbox: Bbox; zoom: number; limit: number; cursor: string | null },
    signal: AbortSignal,
  ): Promise<ListPage>;
  /** Throws a `FeedExpiredError` for 410 CHANGE_FEED_EXPIRED. */
  changes(params: { since: number; limit: number }, signal: AbortSignal): Promise<ChangeFeedResponse>;
}

/** 410 CHANGE_FEED_EXPIRED (the cursor is older than the retention watermark). */
export class FeedExpiredError extends Error {
  constructor() {
    super('Change feed expired');
    this.name = 'FeedExpiredError';
  }
}

export interface RegionLoadResult {
  pages: number;
  items: number;
  bytes: number;
  /** `culledCount` of the first page (null on later pages). */
  culledCount: number | null;
  /** Page 10 still carried a `nextCursor` (UX C-17 truncation notice). */
  truncated: boolean;
  fetchMs: number;
  /** The catch-up could not complete (410 or > 10 pages): the caller reloads the viewport. */
  needsReload: boolean;
}

export type FeedPullOutcome = 'ok' | 'reload';

interface FeedRun {
  lastNextSince: number;
  outcome: FeedPullOutcome;
}

export type ChangeListener = (
  change: ChangeLike & { changeSeq: number },
  outcome: ReturnType<typeof applyChange>['outcome'],
) => void;

export interface AreasSyncOptions {
  store: AreasStoreApi;
  api: AreasSyncApi;
  scheduler: Scheduler;
  /** Called for every applied (or dropped) change: collaboration toasts, pulses, early warnings. */
  onChange?: ChangeListener;
  /** The viewport parts to reload after a 410 / overflow, and the centre used for eviction. */
  viewport: () => { parts: Bbox[]; zoom: number; centre: { lng: number; lat: number } } | null;
}

export class AreasSync {
  private nextRegionId = 1;
  private feedInFlight: Promise<FeedPullOutcome> | null = null;
  private reloading: Promise<void> | null = null;

  constructor(private readonly options: AreasSyncOptions) {}

  private get store(): AreasStoreApi {
    return this.options.store;
  }

  private applyFeedItems(response: ChangeFeedResponse): void {
    const now = this.options.scheduler.now();
    for (const item of response.items) {
      let outcome: ReturnType<typeof applyChange>['outcome'] = 'dropped';
      this.store.getState().update((state) => {
        const result = applyChange(state, item, now);
        outcome = result.outcome;
        return result.state;
      });
      this.options.onChange?.({ op: item.op, area: item.area, changeSeq: item.changeSeq }, outcome);
    }
  }

  /** Reads the feed from `since` (<= 10 pages of 500). Does not touch `restCursor` unless `advance` is set. */
  private async readFeed(since: number, signal: AbortSignal, advance: boolean): Promise<FeedRun> {
    let cursor = since;
    for (let page = 1; page <= CHANGE_FEED_MAX_PAGES; page += 1) {
      let response: ChangeFeedResponse;
      try {
        response = await this.options.api.changes({ since: cursor, limit: CHANGE_FEED_PAGE_LIMIT }, signal);
      } catch (error) {
        if (error instanceof FeedExpiredError) return { lastNextSince: cursor, outcome: 'reload' };
        throw error;
      }
      this.applyFeedItems(response);
      cursor = response.nextSince;
      if (advance) this.store.getState().update((state) => advanceRestCursor(state, response.nextSince));
      if (!response.hasMore) return { lastNextSince: cursor, outcome: 'ok' };
    }
    // More than 10 pages behind: cheaper to reload the viewport than to replay the feed (SPEC section 7.12 step 4).
    return { lastNextSince: cursor, outcome: 'reload' };
  }

  /**
   * Loads every page of one viewport part as a region, then runs the catch-up from `min(restCursor, minAsOf)` and only
   * then marks the region fetched (SPEC section 7.12 step 4).
   */
  async loadRegion(bbox: Bbox, zoom: number, signal: AbortSignal): Promise<RegionLoadResult> {
    const region: Region = { id: this.nextRegionId, bbox, zoom };
    this.nextRegionId += 1;
    this.store.getState().update((state) => beginRegion(state, region));
    const startedAt = this.options.scheduler.now();
    const result: RegionLoadResult = {
      pages: 0,
      items: 0,
      bytes: 0,
      culledCount: null,
      truncated: false,
      fetchMs: 0,
      needsReload: false,
    };
    try {
      let cursor: string | null = null;
      let minAsOf = Number.POSITIVE_INFINITY;
      for (let page = 1; page <= BBOX_MAX_PAGES; page += 1) {
        const response = await this.options.api.listBbox(
          { bbox, zoom, limit: BBOX_PAGE_LIMIT, cursor },
          signal,
        );
        this.store.getState().update((state) => applyListPage(state, response.items, response.precision));
        result.pages = page;
        result.items += response.items.length;
        result.bytes += response.bytes;
        if (page === 1) result.culledCount = response.culledCount;
        minAsOf = Math.min(minAsOf, response.asOfChangeSeq);
        cursor = response.nextCursor;
        if (cursor === null) break;
        if (page === BBOX_MAX_PAGES) result.truncated = true;
      }
      this.store.getState().update((state) => initialiseRestCursor(state, minAsOf));
      const restCursor = currentAreasState(this.store).restCursor ?? minAsOf;
      const catchUp = await this.readFeed(Math.min(restCursor, minAsOf), signal, false);
      result.fetchMs = this.options.scheduler.now() - startedAt;
      if (catchUp.outcome === 'reload') {
        this.store.getState().update((state) => abandonRegion(state, region.id));
        result.needsReload = true;
        return result;
      }
      this.store.getState().update((state) => completeRegion(state, region.id, catchUp.lastNextSince));
      this.evict();
      return result;
    } catch (error) {
      this.store.getState().update((state) => abandonRegion(state, region.id));
      throw error;
    }
  }

  private evict(): void {
    const viewport = this.options.viewport();
    if (viewport === null) return;
    this.store.getState().update((state) => evictIfNeeded(state, viewport.centre));
  }

  /**
   * Pulls the change feed from `restCursor` (resync after `welcome`, anti-entropy, limited-mode polling). Single
   * flight: overlapping callers share one pull. A 410 or > 10 pages triggers the viewport reload.
   */
  pullFeed(signal: AbortSignal = new AbortController().signal): Promise<FeedPullOutcome> {
    if (this.feedInFlight !== null) return this.feedInFlight;
    const run = async (): Promise<FeedPullOutcome> => {
      const cursor = currentAreasState(this.store).restCursor;
      if (cursor === null) return 'ok'; // Nothing loaded yet: the first region load initialises the cursor.
      const feed = await this.readFeed(cursor, signal, true);
      if (feed.outcome === 'reload') await this.reloadViewport(signal);
      return feed.outcome;
    };
    this.feedInFlight = run().finally(() => {
      this.feedInFlight = null;
    });
    return this.feedInFlight;
  }

  /**
   * The 410 path: evict everything outside the current viewport, forget the regions and the cursor, and load the
   * viewport again (which re-initialises `restCursor` from the new pages).
   */
  reloadViewport(signal: AbortSignal = new AbortController().signal): Promise<void> {
    if (this.reloading !== null) return this.reloading;
    const run = async (): Promise<void> => {
      const viewport = this.options.viewport();
      if (viewport === null) return;
      this.store.getState().update((state) => resetForReload(state, viewport.parts));
      for (const part of viewport.parts) {
        const result = await this.loadRegion(part, viewport.zoom, signal);
        // A second overflow right after a reset means the feed is moving faster than we can follow; stop here and let
        // the next anti-entropy round try again rather than looping.
        if (result.needsReload) return;
      }
    };
    this.reloading = run().finally(() => {
      this.reloading = null;
    });
    return this.reloading;
  }
}
