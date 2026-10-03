import { randomUUID } from 'node:crypto';

import type { AreaVersionDto, AreaVersionListResponse } from '@snapland/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { sql } from '../../../src/infra/db/types.js';
import { createUser } from '../../helpers/users.js';
import type { TestUser } from '../../helpers/users.js';
import { createArea, createAreasKit, polygon, problemCode, request, uniqueSquare } from './areas-kit.js';
import type { AreasKit } from './areas-kit.js';

const MUTATE_VERSION = sql(
  'testAreasVersions.mutateVersion',
  "UPDATE area_versions SET name = 'rewritten' WHERE area_id = $1 AND version = 1",
);
const PURGE = sql('testAreasVersions.purge', 'DELETE FROM areas WHERE id = $1');

let kit: AreasKit;
let alice: TestUser;
let bob: TestUser;

beforeAll(async () => {
  kit = await createAreasKit();
  alice = await createUser(kit.testApp.container, { displayName: 'Alice', color: '#c44f9d' });
  bob = await createUser(kit.testApp.container, { displayName: 'Bob', color: '#b86e3d' });
});

afterAll(async () => {
  await kit.close();
});

/** v1 create (Alice) -> v2 rename (Bob) -> v3 merged description edit (Alice, base 1) -> v4 revert of the name -> v5 delete. */
async function areaWithHistory(): Promise<string> {
  const { area } = await createArea(kit, alice, { name: 'First' });
  const id = area.id;
  const steps = [
    () => request(kit, bob, 'PATCH', `/api/v1/areas/${id}`, { baseVersion: 1, name: 'Second' }),
    () => request(kit, alice, 'PATCH', `/api/v1/areas/${id}`, { baseVersion: 1, description: 'merged' }),
    () =>
      request(kit, alice, 'PATCH', `/api/v1/areas/${id}`, { baseVersion: 3, name: 'First', revertedFrom: 1 }),
    () => request(kit, alice, 'DELETE', `/api/v1/areas/${id}?baseVersion=4`),
  ];
  for (const step of steps) expect((await step()).statusCode).toBe(200);
  return id;
}

describe('GET /api/v1/areas/{id}/versions (section 6.3)', () => {
  it('lists the history newest first, also for a soft-deleted area, with revertedFrom and actor colours', async () => {
    const id = await areaWithHistory();
    const response = await request(kit, alice, 'GET', `/api/v1/areas/${id}/versions`);
    expect(response.statusCode).toBe(200);
    const { items, nextCursor } = response.json<AreaVersionListResponse>();
    expect(nextCursor).toBeNull();
    expect(items.map((item) => [item.version, item.op])).toEqual([
      [5, 'delete'],
      [4, 'update'],
      [3, 'update'],
      [2, 'update'],
      [1, 'create'],
    ]);
    expect(items[0]).toMatchObject({ changedFields: ['deleted'], actor: { id: alice.id, color: '#c44f9d' } });
    expect(items[1]).toMatchObject({
      name: 'First',
      changedFields: ['name'],
      revertedFrom: 1,
      merged: false,
    });
    expect(items[2]).toMatchObject({ description: 'merged', changedFields: ['description'], merged: true });
    expect(items[3]).toMatchObject({
      name: 'Second',
      actor: { id: bob.id, color: '#b86e3d' },
      revertedFrom: null,
    });
    expect(items.every((item) => item.geometry === undefined)).toBe(true);
    const changeSeqs = items.map((item) => item.changeSeq);
    expect([...changeSeqs].sort((a, b) => b - a)).toEqual(changeSeqs);
  });

  it('paginates by version keyset and rejects malformed cursors', async () => {
    const id = await areaWithHistory();
    const first = (
      await request(kit, alice, 'GET', `/api/v1/areas/${id}/versions?limit=2`)
    ).json<AreaVersionListResponse>();
    expect(first.items.map((item) => item.version)).toEqual([5, 4]);
    expect(first.nextCursor).toBe('4');
    const second = (
      await request(
        kit,
        alice,
        'GET',
        `/api/v1/areas/${id}/versions?limit=2&cursor=${first.nextCursor ?? ''}`,
      )
    ).json<AreaVersionListResponse>();
    expect(second.items.map((item) => item.version)).toEqual([3, 2]);
    const last = (
      await request(
        kit,
        alice,
        'GET',
        `/api/v1/areas/${id}/versions?limit=2&cursor=${second.nextCursor ?? ''}`,
      )
    ).json<AreaVersionListResponse>();
    expect(last.items.map((item) => item.version)).toEqual([1]);
    expect(last.nextCursor).toBeNull();

    const invalid = await request(kit, alice, 'GET', `/api/v1/areas/${id}/versions?cursor=abc`);
    expect(invalid.statusCode).toBe(400);
    expect(problemCode(invalid)).toBe('INVALID_CURSOR');
  });

  it('includes geometry on request, capped at 20 entries per page', async () => {
    const { area } = await createArea(kit, alice);
    let version = 1;
    for (let index = 0; index < 21; index += 1) {
      const response = await request(kit, alice, 'PATCH', `/api/v1/areas/${area.id}`, {
        baseVersion: version,
        name: `Rename ${index}`,
      });
      expect(response.statusCode).toBe(200);
      version += 1;
    }
    const page = (
      await request(kit, alice, 'GET', `/api/v1/areas/${area.id}/versions?includeGeometry=true`)
    ).json<AreaVersionListResponse>();
    expect(page.items).toHaveLength(20);
    expect(page.nextCursor).toBe('3');
    expect(page.items[0]?.geometry).toEqual(area.geometry);
  });

  it('404 AREA_NOT_FOUND for an unknown id and after the retention purge removed the row', async () => {
    const unknown = await request(kit, alice, 'GET', `/api/v1/areas/${randomUUID()}/versions`);
    expect(unknown.statusCode).toBe(404);
    expect(problemCode(unknown)).toBe('AREA_NOT_FOUND');

    const id = await areaWithHistory();
    await kit.testApp.container.db.query(PURGE, [id]);
    const purged = await request(kit, alice, 'GET', `/api/v1/areas/${id}/versions`);
    expect(purged.statusCode).toBe(404);
    expect(problemCode(purged)).toBe('AREA_NOT_FOUND');
    expect(problemCode(await request(kit, alice, 'GET', `/api/v1/areas/${id}/versions/1`))).toBe(
      'AREA_NOT_FOUND',
    );
  });
});

describe('GET /api/v1/areas/{id}/versions/{version}', () => {
  it('returns one snapshot with geometry, also for a soft-deleted area', async () => {
    const geometry = polygon(uniqueSquare());
    const { area } = await createArea(kit, alice, { name: 'Snapshot', geometry });
    expect((await request(kit, alice, 'DELETE', `/api/v1/areas/${area.id}?baseVersion=1`)).statusCode).toBe(
      200,
    );
    const response = await request(kit, bob, 'GET', `/api/v1/areas/${area.id}/versions/1`);
    expect(response.statusCode).toBe(200);
    expect(response.json<AreaVersionDto>()).toMatchObject({
      areaId: area.id,
      version: 1,
      op: 'create',
      name: 'Snapshot',
      geometry: area.geometry,
      areaKm2: area.areaKm2,
      changedFields: ['name', 'description', 'geometry'],
      actor: { id: alice.id },
    });
  });

  it('404 VERSION_NOT_FOUND for an unknown version of an existing area', async () => {
    const { area } = await createArea(kit, alice);
    const response = await request(kit, alice, 'GET', `/api/v1/areas/${area.id}/versions/9`);
    expect(response.statusCode).toBe(404);
    expect(problemCode(response)).toBe('VERSION_NOT_FOUND');
    expect(problemCode(await request(kit, alice, 'GET', `/api/v1/areas/${randomUUID()}/versions/1`))).toBe(
      'AREA_NOT_FOUND',
    );
  });
});

describe('area_versions is append-only (section 5.2 trigger)', () => {
  it('an UPDATE on area_versions raises an error', async () => {
    const { area } = await createArea(kit, alice);
    await expect(kit.testApp.container.db.query(MUTATE_VERSION, [area.id])).rejects.toThrow(
      'area_versions rows are immutable',
    );
  });
});
