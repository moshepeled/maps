import { AreaListResponseSchema } from '@snapland/shared';
import type { AreaListResponse, Bbox } from '@snapland/shared';
import type { LightMyRequestResponse } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { sql } from '../../../src/infra/db/types.js';
import { createUser } from '../../helpers/users.js';
import type { TestUser } from '../../helpers/users.js';
import { createAreasKit, problemCode, request } from './areas-kit.js';
import type { AreasKit } from './areas-kit.js';

/**
 * Region R (far from every other suite's data): 3,000 squares with extents log-uniform in [1e-4°, 3e-3°] - on both
 * sides of the z12 (6.9e-4°) and z14 (1.7e-4°) culling thresholds - 10 % of them soft-deleted.
 * Region B: 300 max-size polygons (1,997 stored points = 1,996 positions each) for the page position budget.
 */
const REGION: Bbox = [-43.3, -22.95, -43.0, -22.7];
const BUDGET_REGION: Bbox = [-43.5, -22.95, -43.45, -22.91];
const SEEDED = 3000;
const BUDGET_POLYGONS = 300;
const POSITION_BUDGET = 150_000;
const MAX_PAGE_BYTES = 4.5 * 1024 * 1024;

const SEED_REGION = sql(
  'testAreasBbox.seedRegion',
  `INSERT INTO areas (id, name, geom, area_km2, perimeter_km, vertex_count, bbox_extent_deg, version, change_seq,
                      created_by, updated_by, deleted_at, deleted_by)
   SELECT gen_random_uuid(), 'seed ' || g, s.geom, ST_Area(s.geom::geography) / 1e6,
          ST_Perimeter(s.geom::geography) / 1e3, ST_NPoints(s.geom) - ST_NRings(s.geom),
          GREATEST(ST_XMax(s.geom) - ST_XMin(s.geom), ST_YMax(s.geom) - ST_YMin(s.geom)), 1,
          nextval('area_change_seq'), $5::uuid, $5::uuid,
          CASE WHEN g % 10 = 0 THEN now() END, CASE WHEN g % 10 = 0 THEN $5::uuid END
     FROM generate_series(1, $6::int) AS g
     CROSS JOIN LATERAL (
       SELECT exp(ln(1e-4) + random() * (ln(3e-3) - ln(1e-4))) AS size, g AS n,
              $1::float8 + random() * ($3::float8 - $1::float8) AS x,
              $2::float8 + random() * ($4::float8 - $2::float8) AS y
     ) AS r
     CROSS JOIN LATERAL (
       SELECT ST_ForcePolygonCCW(ST_MakeEnvelope(r.x, r.y, r.x + r.size, r.y + r.size, 4326)) AS geom
     ) AS s`,
);

const SEED_MAX_SIZE = sql(
  'testAreasBbox.seedMaxSize',
  `INSERT INTO areas (id, name, geom, area_km2, perimeter_km, vertex_count, bbox_extent_deg, version, change_seq,
                      created_by, updated_by)
   SELECT gen_random_uuid(), 'budget ' || g, s.geom, ST_Area(s.geom::geography) / 1e6,
          ST_Perimeter(s.geom::geography) / 1e3, ST_NPoints(s.geom) - ST_NRings(s.geom),
          GREATEST(ST_XMax(s.geom) - ST_XMin(s.geom), ST_YMax(s.geom) - ST_YMin(s.geom)), 1,
          nextval('area_change_seq'), $5::uuid, $5::uuid
     FROM generate_series(1, $6::int) AS g
     CROSS JOIN LATERAL (
       SELECT g AS n, ST_ForcePolygonCCW(ST_Buffer(ST_SetSRID(ST_MakePoint(
                $1::float8 + random() * ($3::float8 - $1::float8),
                $2::float8 + random() * ($4::float8 - $2::float8)), 4326), 0.002, 499)) AS geom
     ) AS s`,
);

/** The section 5.5 contract computed in SQL: live ∩ intersects queryBbox ∩ extent >= minExtentDeg. */
const EXPECTED_IDS = sql(
  'testAreasBbox.expectedIds',
  `SELECT id FROM areas
    WHERE deleted_at IS NULL
      AND ST_Intersects(geom, ST_MakeEnvelope($1::float8, $2::float8, $3::float8, $4::float8, 4326))
      AND bbox_extent_deg >= $5::float8`,
);
const EXPECTED_CULLED = sql(
  'testAreasBbox.expectedCulled',
  `SELECT count(*)::int AS culled FROM areas
    WHERE deleted_at IS NULL
      AND ST_Intersects(geom, ST_MakeEnvelope($1::float8, $2::float8, $3::float8, $4::float8, 4326))
      AND bbox_extent_deg < $5::float8`,
);
const DELETED_IN_REGION = sql(
  'testAreasBbox.deletedInRegion',
  `SELECT id FROM areas
    WHERE deleted_at IS NOT NULL
      AND ST_Intersects(geom, ST_MakeEnvelope($1::float8, $2::float8, $3::float8, $4::float8, 4326))`,
);
const POSITIONS_OF = sql(
  'testAreasBbox.positionsOf',
  'SELECT COALESCE(sum(vertex_count), 0)::int AS positions FROM areas WHERE id = ANY($1::uuid[])',
);
const SET_WATERMARK = sql(
  'testAreasBbox.setWatermark',
  "UPDATE system_state SET value = to_jsonb($1::bigint) WHERE key = 'change_feed_purge_watermark'",
);

let kit: AreasKit;
let seeder: TestUser;
let viewer: TestUser;

beforeAll(async () => {
  kit = await createAreasKit();
  const { container } = kit.testApp;
  seeder = await createUser(container, { displayName: 'Seeder', color: '#bcfab2' });
  viewer = await createUser(container);
  await container.db.query(SEED_REGION, [...REGION, seeder.id, SEEDED]);
  await container.db.query(SEED_MAX_SIZE, [...BUDGET_REGION, seeder.id, BUDGET_POLYGONS]);
});

afterAll(async () => {
  await kit.close();
});

function bboxParam(bbox: Bbox): string {
  return bbox.join(',');
}

async function getPage(
  bbox: Bbox | string,
  zoom: number,
  options: { limit?: number; cursor?: string; headers?: Record<string, string> } = {},
): Promise<LightMyRequestResponse> {
  const params = new URLSearchParams({
    bbox: typeof bbox === 'string' ? bbox : bboxParam(bbox),
    zoom: String(zoom),
  });
  if (options.limit !== undefined) params.set('limit', String(options.limit));
  if (options.cursor !== undefined) params.set('cursor', options.cursor);
  return request(kit, viewer, 'GET', `/api/v1/areas?${params.toString()}`, undefined, options.headers ?? {});
}

/** Follows nextCursor to the end and returns every page. */
async function allPages(bbox: Bbox, zoom: number, limit: number): Promise<AreaListResponse[]> {
  const pages: AreaListResponse[] = [];
  let cursor: string | undefined;
  for (let guard = 0; guard < 100; guard += 1) {
    const response = await getPage(bbox, zoom, { limit, ...(cursor === undefined ? {} : { cursor }) });
    expect(response.statusCode, response.body).toBe(200);
    const page = response.json<AreaListResponse>();
    pages.push(page);
    if (page.nextCursor === null) return pages;
    cursor = page.nextCursor;
  }
  throw new Error('pagination did not terminate');
}

async function expectedIds(queryBbox: Bbox, minExtentDeg: number): Promise<string[]> {
  const rows = await kit.testApp.container.db.query<{ id: string }>(EXPECTED_IDS, [
    ...queryBbox,
    minExtentDeg,
  ]);
  return rows.map((row) => row.id).sort();
}

function idsOf(pages: readonly AreaListResponse[]): string[] {
  return pages.flatMap((page) => page.items.map((item) => item.id));
}

function maxDecimals(page: AreaListResponse): number {
  let max = 0;
  for (const item of page.items) {
    for (const value of item.geometry.coordinates.flat(2)) {
      max = Math.max(max, (String(value).split('.')[1] ?? '').length);
    }
  }
  return max;
}

describe('GET /api/v1/areas - exact bbox contract (section 5.5, section 6.3)', () => {
  it.each([1000, 2000])(
    'zoom 15, limit %i: keyset pages over 2,500+ live rows return each intersecting area exactly once',
    async (limit) => {
      const pages = await allPages(REGION, 15, limit);
      const ids = idsOf(pages);
      expect(new Set(ids).size).toBe(ids.length);
      const first = pages[0];
      if (first === undefined) throw new Error('no page');
      expect(first.minExtentDeg).toBe(0);
      const expected = await expectedIds(first.queryBbox, 0);
      expect(expected.length).toBeGreaterThanOrEqual(2500);
      expect([...ids].sort()).toEqual(expected);
      expect(pages.length).toBe(Math.ceil(expected.length / limit));
      expect(first.culledCount).toBe(0);
      expect(pages.slice(1).every((page) => page.culledCount === null)).toBe(true);
      // The snapped query bbox contains the requested one (section 10.2).
      expect(first.queryBbox[0]).toBeLessThanOrEqual(REGION[0]);
      expect(first.queryBbox[3]).toBeGreaterThanOrEqual(REGION[3]);
    },
  );

  it('never returns a soft-deleted row', async () => {
    const pages = await allPages(REGION, 15, 2000);
    const deleted = await kit.testApp.container.db.query<{ id: string }>(DELETED_IN_REGION, [
      ...(pages[0]?.queryBbox ?? REGION),
    ]);
    expect(deleted.length).toBeGreaterThan(200);
    const returned = new Set(idsOf(pages));
    expect(deleted.filter((row) => returned.has(row.id))).toEqual([]);
  });

  it('zoom 12: culls sub-pixel areas, reports culledCount on page 1 only, and the union is the exact set', async () => {
    const pages = await allPages(REGION, 12, 1000);
    const first = pages[0];
    if (first === undefined) throw new Error('no page');
    expect(first).toMatchObject({ zoom: 12, simplified: true, precision: 5 });
    expect(first.minExtentDeg).toBeCloseTo(6.866455078125e-4, 12);
    const expected = await expectedIds(first.queryBbox, first.minExtentDeg);
    expect([...idsOf(pages)].sort()).toEqual(expected);
    const [culled] = await kit.testApp.container.db.query<{ culled: number }>(EXPECTED_CULLED, [
      ...first.queryBbox,
      first.minExtentDeg,
    ]);
    expect(culled?.culled).toBeGreaterThan(0);
    expect(first.culledCount).toBe(Math.min(culled?.culled ?? -1, 10_000));
    expect(pages.slice(1).every((page) => page.culledCount === null)).toBe(true);
    expect(maxDecimals(first)).toBeLessThanOrEqual(5);
  });

  it('zoom 10 is simplified with precision 5; zoom 14 precision 6; zoom 17 is full precision 7', async () => {
    const z10 = (await getPage(REGION, 10, { limit: 50 })).json<AreaListResponse>();
    expect(z10).toMatchObject({ zoom: 10, simplified: true, precision: 5 });
    expect(maxDecimals(z10)).toBeLessThanOrEqual(5);

    const z14 = (await getPage([-43.2, -22.85, -43.0, -22.7], 14, { limit: 50 })).json<AreaListResponse>();
    expect(z14).toMatchObject({ zoom: 14, simplified: true, precision: 6 });
    expect(maxDecimals(z14)).toBeLessThanOrEqual(6);

    const small: Bbox = [-43.2, -22.85, -43.13, -22.8];
    const z17 = (await getPage(small, 17, { limit: 2000 })).json<AreaListResponse>();
    expect(z17).toMatchObject({
      zoom: 17,
      simplified: false,
      precision: 7,
      minExtentDeg: 0,
      queryBbox: small,
    });
    expect(z17.items.length).toBeGreaterThan(0);
    const sample = z17.items[0];
    if (sample === undefined) throw new Error('no item');
    const full = await request(kit, viewer, 'GET', `/api/v1/areas/${sample.id}`);
    expect(full.json<{ geometry: unknown }>().geometry).toEqual(sample.geometry);
  });

  it('the page is a schema-valid AreaListResponse whose items carry createdById and updatedBy colour', async () => {
    const page = (await getPage([-43.2, -22.85, -43.13, -22.8], 17)).json<AreaListResponse>();
    // Bbox bodies are serialised once and sent as text, so the zod response serializer never checks them.
    expect(AreaListResponseSchema.parse(page)).toEqual(page);
    expect(page.items[0]).toMatchObject({
      createdById: seeder.id,
      updatedBy: { id: seeder.id, displayName: 'Seeder', color: '#bcfab2' },
    });
  });

  it('weak ETag, 304 on If-None-Match, X-Cache MISS then HIT-L1, Vary and Cache-Control', async () => {
    const bbox: Bbox = [-43.25, -22.9, -43.05, -22.75];
    // The first cacheable read of a fresh Redis prefix initialises the cache epoch and is served BYPASS (section 10.2);
    // a throwaway read of another query makes the sequence below independent of what ran before.
    await getPage(bbox, 13, { limit: 200 });
    const first = await getPage(bbox, 14, { limit: 200 });
    expect(first.statusCode).toBe(200);
    expect(first.headers['content-type']).toContain('application/json');
    const etag = first.headers.etag;
    expect(etag).toMatch(/^W\/"[A-Za-z0-9_-]{27}"$/);
    expect(first.headers['x-cache']).toBe('MISS');
    expect(first.headers.vary).toContain('Authorization');
    expect(first.headers['cache-control']).toBe('private, no-cache');

    const second = await getPage(bbox, 14, { limit: 200 });
    expect(second.headers['x-cache']).toBe('HIT-L1');
    expect(second.headers.etag).toBe(etag);
    expect(second.body).toBe(first.body);

    const notModified = await getPage(bbox, 14, { limit: 200, headers: { 'if-none-match': String(etag) } });
    expect(notModified.statusCode).toBe(304);
    expect(notModified.body).toBe('');

    const bypass = await getPage([-43.2, -22.85, -43.13, -22.8], 17);
    expect(bypass.headers['x-cache']).toBe('BYPASS');
  });

  it('asOfChangeSeq comes from the same snapshot and never drops below the purge watermark', async () => {
    const { container } = kit.testApp;
    const latest = await container.areasReader.latestChangeSeq();
    const bbox: Bbox = [-43.2, -22.85, -43.14, -22.8];
    expect((await getPage(bbox, 17)).json<AreaListResponse>().asOfChangeSeq).toBe(latest);
    await container.db.query(SET_WATERMARK, [latest + 500]);
    try {
      expect((await getPage(bbox, 17)).json<AreaListResponse>().asOfChangeSeq).toBe(latest + 500);
    } finally {
      await container.db.query(SET_WATERMARK, [0]);
    }
  });
});

describe('cursor binding -> 400 INVALID_CURSOR', () => {
  it('rejects a cursor replayed with another limit, zoom or bbox, and garbage', async () => {
    const first = (await getPage(REGION, 15, { limit: 1000 })).json<AreaListResponse>();
    const cursor = first.nextCursor;
    if (cursor === null) throw new Error('expected a second page');
    const attempts = [
      getPage(REGION, 15, { limit: 999, cursor }),
      getPage(REGION, 14, { limit: 1000, cursor }),
      getPage([-43.29, -22.95, -43.0, -22.7], 13, { limit: 1000, cursor }),
      getPage(REGION, 15, { limit: 1000, cursor: 'garbage' }),
    ];
    for (const response of await Promise.all(attempts)) {
      expect(response.statusCode, response.body).toBe(400);
      expect(problemCode(response)).toBe('INVALID_CURSOR');
    }
  });
});

describe('span cap and bbox rules -> 400 INVALID_BBOX (section 5.5)', () => {
  it.each([
    ['the world at zoom 17', '-180,-85,180,85', 17],
    ['west ≥ east', '-43.0,-22.9,-43.1,-22.8', 12],
    ['lat 86', '-43.1,85.9,-43.0,86', 12],
    ['a non-numeric value', '-43.1,abc,-43.0,-22.8', 12],
    ['three values', '-43.1,-22.9,-43.0', 12],
    ['0.3° wide at zoom 16', '-43.3,-22.9,-43.0,-22.8', 16],
  ])('%s', async (_label, bbox, zoom) => {
    const response = await getPage(bbox, zoom);
    expect(response.statusCode, response.body).toBe(400);
    expect(problemCode(response)).toBe('INVALID_BBOX');
  });

  it('transport limits stay VALIDATION_FAILED (zoom 23, limit 2001, a missing bbox)', async () => {
    for (const url of [
      `/api/v1/areas?bbox=${bboxParam(REGION)}&zoom=23`,
      `/api/v1/areas?bbox=${bboxParam(REGION)}&zoom=15&limit=2001`,
      '/api/v1/areas?zoom=15',
    ]) {
      const response = await request(kit, viewer, 'GET', url);
      expect(response.statusCode, url).toBe(400);
      expect(problemCode(response)).toBe('VALIDATION_FAILED');
    }
  });
});

describe('page position budget (LIMITS.bboxPagePositionBudget = 150,000, section 5.5)', () => {
  it('300 max-size polygons at z17: pages stop within the budget, carry nextCursor, and union to the set', async () => {
    const cutsBefore =
      (await kit.testApp.container.metrics.areaBboxPageBudgetCutsTotal.get()).values[0]?.value ?? 0;
    const pages: { page: AreaListResponse; bytes: number }[] = [];
    let cursor: string | undefined;
    do {
      const response = await getPage(BUDGET_REGION, 17, {
        limit: 2000,
        ...(cursor === undefined ? {} : { cursor }),
      });
      expect(response.statusCode).toBe(200);
      const page = response.json<AreaListResponse>();
      pages.push({ page, bytes: Buffer.byteLength(response.body) });
      cursor = page.nextCursor ?? undefined;
    } while (cursor !== undefined && pages.length < 50);

    const first = pages[0];
    if (first === undefined) throw new Error('no page');
    expect(first.page.nextCursor).not.toBeNull();
    expect(first.page.items.length).toBeLessThan(BUDGET_POLYGONS);
    for (const { page, bytes } of pages) {
      const [row] = await kit.testApp.container.db.query<{ positions: number }>(POSITIONS_OF, [
        page.items.map((item) => item.id),
      ]);
      expect(row?.positions).toBeLessThanOrEqual(POSITION_BUDGET);
      expect(bytes).toBeLessThanOrEqual(MAX_PAGE_BYTES);
    }
    const ids = pages.flatMap(({ page }) => page.items.map((item) => item.id));
    expect(new Set(ids).size).toBe(ids.length);
    expect([...ids].sort()).toEqual(await expectedIds(BUDGET_REGION, 0));
    expect(ids.length).toBeGreaterThanOrEqual(BUDGET_POLYGONS);

    const cutsAfter =
      (await kit.testApp.container.metrics.areaBboxPageBudgetCutsTotal.get()).values[0]?.value ?? 0;
    expect(cutsAfter - cutsBefore).toBe(pages.length - 1);
  });
});
