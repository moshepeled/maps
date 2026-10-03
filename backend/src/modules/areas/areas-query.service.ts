/**
 * Area reads (SPEC section 6.3, section 5.5): the bbox list (span-capped, LOD, keyset-paginated, position-budgeted, cache-aside),
 * a single area, the edit history (also for soft-deleted areas until the retention purge) and the change feed.
 */
import { LIMITS, lodForZoom } from '@snapland/shared';
import type {
  AreaBboxQuery,
  AreaDto,
  AreaListResponse,
  AreaVersionDto,
  AreaVersionListResponse,
  AreaVersionsQuery,
  ChangeFeedResponse,
  LevelOfDetail,
} from '@snapland/shared';

import type { AreaQueryCache, BboxQueryPlan, CacheOutcome } from '../../infra/cache/types.js';
import { planBboxQuery } from '../../infra/cache/key-plan.js';
import type { Db, DbTx } from '../../infra/db/types.js';
import { AppError } from '../../infra/http/errors.js';
import type { Metrics } from '../../infra/metrics/metrics.js';
import { areaNotFound, versionNotFound } from './area-errors.js';
import { areasRepository } from './areas.repository.js';
import { parseBboxParam } from './bbox-params.js';
import { decodeBboxCursor, decodeVersionCursor, encodeBboxCursor, encodeVersionCursor } from './cursor.js';
import { cutPage } from './page-budget.js';

export interface AreasQueryServiceDeps {
  db: Db;
  areaCache: AreaQueryCache;
  metrics: Metrics;
}

/** A serialised bbox page (the cache stores bodies, so the route sends it as is). */
export interface BboxPage {
  body: string;
  outcome: CacheOutcome;
  /** Items on the page when it was loaded by this request; null when it came from the cache. */
  itemCount: number | null;
}

const SNAPSHOT_READ = { isolation: 'repeatable read', readOnly: true } as const;

/** Label of `snapland_area_bbox_query_rows`, following the LOD bands of section 5.5. */
export function zoomBucket(zoom: number): string {
  if (zoom <= 9) return '0-9';
  if (zoom <= 13) return '10-13';
  if (zoom === 14) return '14';
  if (zoom <= 16) return '15-16';
  return '17+';
}

export class AreasQueryService {
  readonly #deps: AreasQueryServiceDeps;

  constructor(deps: AreasQueryServiceDeps) {
    this.#deps = deps;
  }

  /**
   * GET /areas: parse and cap the bbox (400 INVALID_BBOX), snap it to the cache grid, validate the cursor against that
   * exact query (400 INVALID_CURSOR), then serve the page cache-aside.
   */
  async listInBbox(query: AreaBboxQuery): Promise<BboxPage> {
    const { zoom } = query;
    const bbox = parseBboxParam(query.bbox, zoom);
    const limit = query.limit ?? LIMITS.bboxPageLimitDefault;
    const plan = planBboxQuery(bbox, zoom);
    const afterId =
      query.cursor === undefined
        ? null
        : decodeBboxCursor(query.cursor, { queryBbox: plan.queryBbox, zoom, limit });
    let itemCount: number | null = null;
    const { body, outcome } = await this.#deps.areaCache.getOrLoad(
      { plan, limit, cursor: query.cursor ?? null },
      async () => {
        const page = await this.#loadBboxPage(plan, limit, afterId);
        itemCount = page.items.length;
        return JSON.stringify(page);
      },
    );
    return { body, outcome, itemCount };
  }

  /**
   * One page in a REPEATABLE READ READ ONLY snapshot, so `asOfChangeSeq` (the section 5.5 latestChangeSeq definition) matches
   * the rows exactly; `culledCount` only on the first page.
   */
  #loadBboxPage(plan: BboxQueryPlan, limit: number, afterId: string | null): Promise<AreaListResponse> {
    const lod = lodForZoom(plan.zoom);
    return this.#deps.db.withTransaction(async (tx) => {
      await areasRepository.applyBboxTxSettings(tx);
      const asOfChangeSeq = await areasRepository.latestChangeSeq(tx);
      const rows = await areasRepository.findInBbox(tx, {
        queryBbox: plan.queryBbox,
        simplifyDeg: lod.simplifyDeg,
        digits: lod.digits,
        minExtentDeg: lod.minExtentDeg,
        afterId,
        fetchLimit: limit + 1,
        positionBudget: LIMITS.bboxPagePositionBudget,
      });
      const culledCount = afterId === null ? await this.#culledCount(tx, plan, lod) : null;
      const page = cutPage(rows, limit);
      this.#deps.metrics.areaBboxQueryRows.observe({ zoom_bucket: zoomBucket(plan.zoom) }, page.items.length);
      if (page.cutByBudget) this.#deps.metrics.areaBboxPageBudgetCutsTotal.inc();
      const last = page.items.at(-1);
      const nextCursor =
        page.hasMore && last !== undefined
          ? encodeBboxCursor(last.id, { queryBbox: plan.queryBbox, zoom: plan.zoom, limit })
          : null;
      return {
        items: page.items,
        nextCursor,
        asOfChangeSeq,
        simplified: lod.simplified,
        precision: lod.digits,
        zoom: plan.zoom,
        queryBbox: plan.queryBbox,
        minExtentDeg: lod.minExtentDeg,
        culledCount,
      };
    }, SNAPSHOT_READ);
  }

  /** Nothing is culled at zoom >= 15; below, the omission is counted (capped) and reported, never silent. */
  async #culledCount(tx: DbTx, plan: BboxQueryPlan, lod: LevelOfDetail): Promise<number> {
    if (lod.minExtentDeg <= 0) return 0;
    return areasRepository.countCulled(tx, plan.queryBbox, lod.minExtentDeg, LIMITS.culledCountCap);
  }

  /** GET /areas/{id}: tombstones only with `includeDeleted=true`. */
  async getArea(id: string, includeDeleted: boolean): Promise<AreaDto> {
    const area = await areasRepository.findById(this.#deps.db, id);
    if (area === null || (area.deletedAt !== null && !includeDeleted)) throw areaNotFound(id);
    return area;
  }

  /**
   * GET /areas/{id}/versions: newest first, keyset on version. With geometry the page is capped at 20 entries (the
   * default limit of 50 is lowered rather than rejected). 404 only when the area row is gone (purged / never existed).
   */
  async listVersions(id: string, query: AreaVersionsQuery): Promise<AreaVersionListResponse> {
    const includeGeometry = query.includeGeometry === true;
    const requested = query.limit ?? LIMITS.versionsLimitDefault;
    const limit = includeGeometry ? Math.min(requested, LIMITS.versionsWithGeometryLimitMax) : requested;
    const beforeVersion = query.cursor === undefined ? null : decodeVersionCursor(query.cursor);
    await this.#assertAreaRowExists(id);
    const rows = await areasRepository.listVersions(this.#deps.db, {
      areaId: id,
      beforeVersion,
      fetchLimit: limit + 1,
      includeGeometry,
    });
    const items = rows.slice(0, limit);
    const last = items.at(-1);
    const nextCursor = rows.length > limit && last !== undefined ? encodeVersionCursor(last.version) : null;
    return { items, nextCursor };
  }

  /** GET /areas/{id}/versions/{version} (with geometry). */
  async getVersion(id: string, version: number): Promise<AreaVersionDto> {
    await this.#assertAreaRowExists(id);
    const record = await areasRepository.findVersion(this.#deps.db, id, version);
    if (record === null) throw versionNotFound(id, version);
    return record;
  }

  /**
   * GET /areas/changes: ordered by changeSeq in one snapshot. `since` older than the retention watermark -> 410 (the
   * client reloads its viewport); `latestChangeSeq` never drops below the watermark (section 5.5).
   */
  changesSince(since: number, limit: number | undefined): Promise<ChangeFeedResponse> {
    const pageSize = limit ?? LIMITS.changeFeedLimitDefault;
    return this.#deps.db.withTransaction(async (tx) => {
      const watermark = await areasRepository.purgeWatermark(tx);
      if (since < watermark) {
        throw new AppError(
          'CHANGE_FEED_EXPIRED',
          `Changes before ${watermark} were purged; reload the viewport.`,
          { extensions: { watermark } },
        );
      }
      const latestChangeSeq = await areasRepository.latestChangeSeq(tx);
      const rows = await areasRepository.changesSince(tx, since, pageSize + 1);
      const items = rows.slice(0, pageSize);
      return {
        items,
        nextSince: items.at(-1)?.changeSeq ?? since,
        hasMore: rows.length > pageSize,
        latestChangeSeq,
      };
    }, SNAPSHOT_READ);
  }

  /** History stays readable for soft-deleted areas; only a missing row is a 404 (section 6.3). */
  async #assertAreaRowExists(id: string): Promise<void> {
    if (!(await areasRepository.exists(this.#deps.db, id))) throw areaNotFound(id);
  }
}
