import type { ChangeFeedResponse } from '@snapland/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { sql } from '../../../src/infra/db/types.js';
import { createUser } from '../../helpers/users.js';
import type { TestUser } from '../../helpers/users.js';
import { createArea, createAreasKit, polygon, problemCode, request, uniqueSquare } from './areas-kit.js';
import type { AreasKit } from './areas-kit.js';

const SET_WATERMARK = sql(
  'testChangeFeed.setWatermark',
  "UPDATE system_state SET value = to_jsonb($1::bigint) WHERE key = 'change_feed_purge_watermark'",
);

let kit: AreasKit;
let alice: TestUser;
let bob: TestUser;

beforeAll(async () => {
  kit = await createAreasKit();
  alice = await createUser(kit.testApp.container, { displayName: 'Alice', color: '#c44f9d' });
  bob = await createUser(kit.testApp.container);
});

afterAll(async () => {
  await kit.testApp.container.db.query(SET_WATERMARK, [0]);
  await kit.close();
});

async function feed(since: number, limit?: number): Promise<ChangeFeedResponse> {
  const query = limit === undefined ? `since=${since}` : `since=${since}&limit=${limit}`;
  const response = await request(kit, alice, 'GET', `/api/v1/areas/changes?${query}`);
  expect(response.statusCode, response.body).toBe(200);
  return response.json<ChangeFeedResponse>();
}

async function latest(): Promise<number> {
  return (await feed(Number.MAX_SAFE_INTEGER - 1)).latestChangeSeq;
}

describe('GET /api/v1/areas/changes (section 6.3, section 5.5 gap-free feed)', () => {
  it('orders 50 concurrent creates with strictly increasing changeSeq, gap-free', async () => {
    const since = await latest();
    const created = await Promise.all(
      Array.from({ length: 50 }, (_, index) =>
        request(kit, index % 2 === 0 ? alice : bob, 'POST', '/api/v1/areas', {
          name: `Concurrent ${index}`,
          geometry: polygon(uniqueSquare()),
        }),
      ),
    );
    expect(created.every((response) => response.statusCode === 201)).toBe(true);
    const page = await feed(since, 1000);
    expect(page.items).toHaveLength(50);
    expect(page.hasMore).toBe(false);
    const seqs = page.items.map((item) => item.changeSeq);
    seqs.forEach((seq, index) => {
      if (index > 0) expect(seq).toBeGreaterThan(seqs[index - 1] ?? Number.POSITIVE_INFINITY);
    });
    // Commit order equals seq order: 50 consecutive seqs after `since`, no gap. The first one can be above since + 1
    // when an earlier file in this run consumed sequence values and then deleted those rows (retention, purges).
    const first = seqs[0] ?? 0;
    expect(first).toBeGreaterThan(since);
    expect(seqs).toEqual(Array.from({ length: 50 }, (_, index) => first + index));
    expect(page.nextSince).toBe(seqs.at(-1));
    expect(page.latestChangeSeq).toBe(seqs.at(-1));
    expect(new Set(page.items.map((item) => item.areaId)).size).toBe(50);
  });

  it('pages with nextSince/hasMore and describes each version as of that change', async () => {
    const since = await latest();
    const { area } = await createArea(kit, alice, { name: 'Fed' });
    expect(
      (await request(kit, bob, 'PATCH', `/api/v1/areas/${area.id}`, { baseVersion: 1, name: 'Fed again' }))
        .statusCode,
    ).toBe(200);
    expect((await request(kit, alice, 'DELETE', `/api/v1/areas/${area.id}?baseVersion=2`)).statusCode).toBe(
      200,
    );

    const first = await feed(since, 2);
    expect(first.hasMore).toBe(true);
    expect(first.items.map((item) => [item.op, item.version])).toEqual([
      ['create', 1],
      ['update', 2],
    ]);
    expect(first.items[0]).toMatchObject({
      areaId: area.id,
      changedFields: ['name', 'description', 'geometry'],
      actor: { id: alice.id, color: '#c44f9d' },
      area: { name: 'Fed', version: 1, deletedAt: null, createdBy: { id: alice.id } },
    });
    expect(first.items[1]).toMatchObject({
      changedFields: ['name'],
      area: { name: 'Fed again', version: 2, updatedBy: { id: bob.id }, createdBy: { id: alice.id } },
    });
    const second = await feed(first.nextSince, 2);
    expect(second.hasMore).toBe(false);
    expect(second.items).toHaveLength(1);
    expect(second.items[0]).toMatchObject({ op: 'delete', changedFields: ['deleted'], area: { version: 3 } });
    expect(second.items[0]?.area.deletedAt).toBe(second.items[0]?.occurredAt);

    const empty = await feed(second.nextSince);
    expect(empty).toMatchObject({ items: [], hasMore: false, nextSince: second.nextSince });
  });

  it('since < watermark -> 410 CHANGE_FEED_EXPIRED with the watermark; latestChangeSeq never drops below it', async () => {
    const current = await latest();
    const watermark = current + 1000;
    await kit.testApp.container.db.query(SET_WATERMARK, [watermark]);
    try {
      const expired = await request(kit, alice, 'GET', `/api/v1/areas/changes?since=${current}`);
      expect(expired.statusCode).toBe(410);
      expect(problemCode(expired)).toBe('CHANGE_FEED_EXPIRED');
      expect(expired.json<{ watermark: number }>().watermark).toBe(watermark);

      const atWatermark = await feed(watermark);
      expect(atWatermark.latestChangeSeq).toBe(watermark);
      expect(atWatermark.items).toEqual([]);
    } finally {
      await kit.testApp.container.db.query(SET_WATERMARK, [0]);
    }
  });

  it('a negative or missing since is a transport 400', async () => {
    for (const url of [
      '/api/v1/areas/changes',
      '/api/v1/areas/changes?since=-1',
      '/api/v1/areas/changes?since=x',
    ]) {
      const response = await request(kit, alice, 'GET', url);
      expect(response.statusCode, url).toBe(400);
      expect(problemCode(response)).toBe('VALIDATION_FAILED');
    }
  });
});
