import { randomUUID } from 'node:crypto';

import { signedRingArea2 } from '@snapland/shared';
import type { AreaDto, AreaMutationResponse, Position } from '@snapland/shared';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { sql } from '../../../src/infra/db/types.js';
import { AreasBusPayloadSchema } from '../../../src/infra/events/payloads.js';
import { loadFixtures } from '../../helpers/fixtures.js';
import { createUser } from '../../helpers/users.js';
import type { TestUser } from '../../helpers/users.js';
import {
  createArea,
  createAreasKit,
  polygon,
  problemCode,
  rectangle,
  request,
  uniqueSquare,
} from './areas-kit.js';
import type { AreasKit } from './areas-kit.js';

const STORED = sql(
  'testAreasCrud.stored',
  `SELECT ST_IsPolygonCCW(geom) AS ccw, ST_AsText(geom) AS wkt, version,
          (SELECT count(*)::int FROM area_versions v WHERE v.area_id = a.id) AS versions
     FROM areas a WHERE id = $1`,
);

let kit: AreasKit;
let alice: TestUser;
let bob: TestUser;
let admin: TestUser;

beforeAll(async () => {
  kit = await createAreasKit();
  alice = await createUser(kit.testApp.container, { displayName: 'Alice', color: '#c44f9d' });
  bob = await createUser(kit.testApp.container, { displayName: 'Bob', color: '#b86e3d' });
  admin = await createUser(kit.testApp.container, { role: 'admin' });
});

afterAll(async () => {
  await kit.close();
});

async function stored(id: string): Promise<{ ccw: boolean; wkt: string; version: number; versions: number }> {
  const [row] = await kit.testApp.container.db.query<{
    ccw: boolean;
    wkt: string;
    version: number;
    versions: number;
  }>(STORED, [id]);
  if (row === undefined) throw new Error(`area ${id} not stored`);
  return row;
}

function maxDecimals(positions: readonly Position[]): number {
  return Math.max(...positions.flat().map((value) => (String(value).split('.')[1] ?? '').length));
}

describe('POST /api/v1/areas - create (section 6.3, section 5.5 write path)', () => {
  it('stores the 10 valid fixtures with PostGIS areaKm2 and perimeterKm within 1e-6', async () => {
    for (const fixture of loadFixtures().polygons) {
      const response = await request(kit, alice, 'POST', '/api/v1/areas', {
        name: fixture.name,
        geometry: fixture.geojson,
      });
      expect(response.statusCode, `${fixture.name}: ${response.body}`).toBe(201);
      const { area } = response.json<AreaMutationResponse>();
      const expectedArea = fixture.area_km2_spheroid ?? Number.NaN;
      const expectedPerimeter = fixture.perimeter_km ?? Number.NaN;
      expect(Math.abs(area.areaKm2 - expectedArea) / expectedArea, fixture.name).toBeLessThanOrEqual(1e-6);
      expect(
        Math.abs(area.perimeterKm - expectedPerimeter) / expectedPerimeter,
        fixture.name,
      ).toBeLessThanOrEqual(1e-6);
      expect(area.version).toBe(1);
      expect((await stored(area.id)).ccw, `${fixture.name} stored CCW`).toBe(true);
    }
  });

  it('answers 201 with Location, ETag "v1", the actor as UserRef with colour, and one version row', async () => {
    const response = await request(kit, alice, 'POST', '/api/v1/areas', {
      name: '  Rabin   Square ',
      description: 'Event perimeter',
      geometry: polygon(uniqueSquare()),
    });
    expect(response.statusCode).toBe(201);
    const body = response.json<AreaMutationResponse>();
    expect(response.headers.location).toBe(`/api/v1/areas/${body.area.id}`);
    expect(response.headers.etag).toBe('"v1"');
    expect(response.headers['x-draw-ratelimit-remaining']).toBeDefined();
    expect(body).toMatchObject({ merged: false, noop: false, serverChangedFields: [] });
    expect(body.area).toMatchObject({
      name: 'Rabin Square',
      description: 'Event perimeter',
      version: 1,
      vertexCount: 4,
      createdBy: { id: alice.id, displayName: 'Alice', color: '#c44f9d' },
      updatedBy: { id: alice.id, color: '#c44f9d' },
      deletedAt: null,
      deletedBy: null,
    });
    expect((await stored(body.area.id)).versions).toBe(1);
  });

  it('stores a clockwise ring counter-clockwise, quantised to 7 dp', async () => {
    const ring: Position[] = [
      [34.781234567891, 32.081234567891],
      [34.781234567891, 32.082234567891],
      [34.782234567891, 32.082234567891],
      [34.782234567891, 32.081234567891],
      [34.781234567891, 32.081234567891],
    ];
    expect(signedRingArea2(ring)).toBeLessThan(0);
    const { area } = await createArea(kit, alice, { geometry: polygon([ring]) });
    const exterior = area.geometry.coordinates[0] ?? [];
    expect(signedRingArea2(exterior)).toBeGreaterThan(0);
    expect(maxDecimals(exterior)).toBeLessThanOrEqual(7);
    expect(exterior[0]).toEqual([34.7812346, 32.0812346]);
    expect((await stored(area.id)).ccw).toBe(true);
  });

  it('a create without a client id gets a server-generated uuid', async () => {
    const { area } = await createArea(kit, alice, { geometry: polygon(uniqueSquare()) });
    expect(area.id).toMatch(/^[0-9a-f-]{36}$/);
  });
});

describe('GET /api/v1/areas/{id}', () => {
  it('returns the full area with ETag "v{version}" and 304 on If-None-Match', async () => {
    const { area } = await createArea(kit, alice);
    const response = await request(kit, bob, 'GET', `/api/v1/areas/${area.id}`);
    expect(response.statusCode).toBe(200);
    expect(response.headers.etag).toBe('"v1"');
    expect(response.headers['cache-control']).toBe('private, no-cache');
    expect(response.json<AreaDto>()).toEqual(area);

    const notModified = await request(kit, bob, 'GET', `/api/v1/areas/${area.id}`, undefined, {
      'if-none-match': '"v1"',
    });
    expect(notModified.statusCode).toBe(304);
    expect(notModified.body).toBe('');
    const stale = await request(kit, bob, 'GET', `/api/v1/areas/${area.id}`, undefined, {
      'if-none-match': '"v0"',
    });
    expect(stale.statusCode).toBe(200);
  });

  it('404 AREA_NOT_FOUND for an unknown id; tombstones only with includeDeleted=true', async () => {
    const unknown = await request(kit, alice, 'GET', `/api/v1/areas/${randomUUID()}`);
    expect(unknown.statusCode).toBe(404);
    expect(problemCode(unknown)).toBe('AREA_NOT_FOUND');

    const { area } = await createArea(kit, alice);
    const deleted = await request(kit, alice, 'DELETE', `/api/v1/areas/${area.id}?baseVersion=1`);
    expect(deleted.statusCode).toBe(200);
    expect(problemCode(await request(kit, alice, 'GET', `/api/v1/areas/${area.id}`))).toBe('AREA_NOT_FOUND');
    const tombstone = await request(kit, alice, 'GET', `/api/v1/areas/${area.id}?includeDeleted=true`);
    expect(tombstone.statusCode).toBe(200);
    expect(tombstone.json<AreaDto>()).toMatchObject({
      version: 2,
      deletedBy: { id: alice.id, color: '#c44f9d' },
    });
    expect(tombstone.json<AreaDto>().deletedAt).not.toBeNull();
  });
});

describe('idempotent create (section 6.3: compare with version 1 and created_by, answer with the CURRENT state)', () => {
  it('an identical retry -> 200 Idempotent-Replay, no new version, no bus event', async () => {
    const id = randomUUID();
    const body = { id, name: 'Retry me', geometry: polygon(uniqueSquare()) };
    const first = await request(kit, alice, 'POST', '/api/v1/areas', body);
    expect(first.statusCode).toBe(201);
    const eventsBefore = kit.events.length;

    const retry = await request(kit, alice, 'POST', '/api/v1/areas', body);
    expect(retry.statusCode).toBe(200);
    expect(retry.headers['idempotent-replay']).toBe('true');
    expect(retry.json<AreaMutationResponse>().area).toEqual(first.json<AreaMutationResponse>().area);
    expect(kit.events).toHaveLength(eventsBefore);
    expect(await stored(id)).toMatchObject({ version: 1, versions: 1 });
  });

  it('A creates, B renames (v2), A retries -> 200 with the v2 state (no 409, no duplicate)', async () => {
    const id = randomUUID();
    const body = { id, name: 'Original', geometry: polygon(uniqueSquare()) };
    expect((await request(kit, alice, 'POST', '/api/v1/areas', body)).statusCode).toBe(201);
    const rename = await request(kit, bob, 'PATCH', `/api/v1/areas/${id}`, {
      baseVersion: 1,
      name: 'Renamed',
    });
    expect(rename.statusCode).toBe(200);

    const retry = await request(kit, alice, 'POST', '/api/v1/areas', body);
    expect(retry.statusCode).toBe(200);
    expect(retry.headers['idempotent-replay']).toBe('true');
    const replayed = retry.json<AreaMutationResponse>();
    expect(replayed.area).toMatchObject({ id, version: 2, name: 'Renamed', updatedBy: { id: bob.id } });
    expect(replayed.serverChangedFields).toEqual(['name']);
    expect(await stored(id)).toMatchObject({ version: 2, versions: 2 });

    // After another user (an admin) deletes it, the retry answers with the tombstone.
    const removal = await request(kit, admin, 'DELETE', `/api/v1/areas/${id}?baseVersion=2`);
    expect(removal.statusCode).toBe(200);
    const afterDelete = await request(kit, alice, 'POST', '/api/v1/areas', body);
    expect(afterDelete.statusCode).toBe(200);
    expect(afterDelete.json<AreaMutationResponse>().area).toMatchObject({ id, version: 3 });
    expect(afterDelete.json<AreaMutationResponse>().area.deletedAt).not.toBeNull();
  });

  it('different content, or another caller, -> 409 AREA_ID_CONFLICT', async () => {
    const id = randomUUID();
    const geometry = polygon(uniqueSquare());
    expect(
      (await request(kit, alice, 'POST', '/api/v1/areas', { id, name: 'Mine', geometry })).statusCode,
    ).toBe(201);
    const otherName = await request(kit, alice, 'POST', '/api/v1/areas', { id, name: 'Other', geometry });
    expect(otherName.statusCode).toBe(409);
    expect(problemCode(otherName)).toBe('AREA_ID_CONFLICT');
    const otherGeometry = await request(kit, alice, 'POST', '/api/v1/areas', {
      id,
      name: 'Mine',
      geometry: polygon(uniqueSquare()),
    });
    expect(problemCode(otherGeometry)).toBe('AREA_ID_CONFLICT');
    const otherCaller = await request(kit, bob, 'POST', '/api/v1/areas', { id, name: 'Mine', geometry });
    expect(problemCode(otherCaller)).toBe('AREA_ID_CONFLICT');
  });

  it('a retry that differs only by sanitisation, winding or sub-7-dp noise is still a replay', async () => {
    const id = randomUUID();
    const ring = uniqueSquare()[0] ?? [];
    expect(
      (await request(kit, alice, 'POST', '/api/v1/areas', { id, name: 'Same', geometry: polygon([ring]) }))
        .statusCode,
    ).toBe(201);
    const noisy = [...ring].reverse().map(([lng, lat]): Position => [lng + 1e-9, lat]);
    const retry = await request(kit, alice, 'POST', '/api/v1/areas', {
      id,
      name: ' Same​ ',
      description: '',
      geometry: polygon([noisy]),
    });
    expect(retry.statusCode).toBe(200);
    expect(retry.headers['idempotent-replay']).toBe('true');
  });
});

describe('draft-owner squatting guard (section 6.3, section 7.6)', () => {
  const owner = (user: TestUser) => ({
    userId: user.id,
    sessionId: user.sessionId,
    connectionId: randomUUID(),
    instanceId: 'test',
  });

  it("an id claimed by another user's live draft -> 409 AREA_ID_CONFLICT and no row", async () => {
    const id = randomUUID();
    await kit.testApp.container.drafts.claim(id, owner(bob));
    const response = await request(kit, alice, 'POST', '/api/v1/areas', {
      id,
      name: 'Squat',
      geometry: polygon(uniqueSquare()),
    });
    expect(response.statusCode).toBe(409);
    expect(problemCode(response)).toBe('AREA_ID_CONFLICT');
    expect((await request(kit, alice, 'GET', `/api/v1/areas/${id}?includeDeleted=true`)).statusCode).toBe(
      404,
    );
  });

  it("the caller's own claimed draft id -> 201", async () => {
    const id = randomUUID();
    await kit.testApp.container.drafts.claim(id, owner(alice));
    const { area } = await createArea(kit, alice, { id });
    expect(area.id).toBe(id);
  });
});

describe('areas bus events (section 7.10, section 6.3 publish-before-reply) and cache invalidation', () => {
  /** Runs a request and reports whether the (single) new bus event was delivered before inject() resolved. */
  async function observe(
    run: () => ReturnType<typeof request>,
  ): Promise<{ statusCode: number; newEvents: number; deliveredBeforeReply: boolean }> {
    const before = kit.events.length;
    let resolved = false;
    let deliveredBeforeReply = false;
    const unsubscribe = kit.testApp.container.events.subscribe('areas', () => {
      deliveredBeforeReply = !resolved;
    });
    try {
      const response = await run().then((result) => {
        resolved = true;
        return result;
      });
      return { statusCode: response.statusCode, newEvents: kit.events.length - before, deliveredBeforeReply };
    } finally {
      unsubscribe();
    }
  }

  it('exactly one event per committed mutation, delivered before the reply; old and new bboxes invalidated', async () => {
    const id = randomUUID();
    const first = rectangle(34.9, 32.1, 34.901, 32.101);
    const moved = rectangle(34.95, 32.15, 34.951, 32.151);

    const created = await observe(() =>
      request(kit, alice, 'POST', '/api/v1/areas', { id, name: 'Evented', geometry: polygon(first) }),
    );
    expect(created).toEqual({ statusCode: 201, newEvents: 1, deliveredBeforeReply: true });
    expect(kit.events.at(-1)).toMatchObject({
      op: 'create',
      prevBbox: null,
      previousName: null,
      area: { id, version: 1 },
      actor: { id: alice.id, color: '#c44f9d' },
    });

    const invalidate = vi.spyOn(kit.testApp.container.areaCache, 'invalidate');
    const updated = await observe(() =>
      request(kit, bob, 'PATCH', `/api/v1/areas/${id}`, {
        baseVersion: 1,
        name: 'Moved',
        geometry: polygon(moved),
      }),
    );
    expect(updated).toEqual({ statusCode: 200, newEvents: 1, deliveredBeforeReply: true });
    expect(kit.events.at(-1)).toMatchObject({
      op: 'update',
      changedFields: ['name', 'geometry'],
      previousName: 'Evented',
      prevBbox: [34.9, 32.1, 34.901, 32.101],
      area: { version: 2, bbox: [34.95, 32.15, 34.951, 32.151] },
      actor: { id: bob.id, color: '#b86e3d' },
    });
    expect(invalidate).toHaveBeenCalledTimes(1);
    expect(invalidate).toHaveBeenCalledWith([
      [34.9, 32.1, 34.901, 32.101],
      [34.95, 32.15, 34.951, 32.151],
    ]);
    invalidate.mockRestore();

    const deleted = await observe(() => request(kit, alice, 'DELETE', `/api/v1/areas/${id}?baseVersion=2`));
    expect(deleted).toEqual({ statusCode: 200, newEvents: 1, deliveredBeforeReply: true });
    expect(kit.events.at(-1)).toMatchObject({ op: 'delete', changedFields: ['deleted'] });
    // Remote subscribers validate bus payloads with the section 7.10 schema: every local payload must pass it.
    for (const payload of kit.events) expect(AreasBusPayloadSchema.safeParse(payload).success).toBe(true);

    const restored = await observe(() =>
      request(kit, alice, 'POST', `/api/v1/areas/${id}/restore`, { baseVersion: 3 }),
    );
    expect(restored).toEqual({ statusCode: 200, newEvents: 1, deliveredBeforeReply: true });
    expect(kit.events.at(-1)).toMatchObject({ op: 'restore', area: { version: 4, deletedAt: null } });
  });

  it('no event on a failure, a rollback, a no-op or a replay', async () => {
    const { area } = await createArea(kit, alice);
    const failures = [
      () => request(kit, alice, 'POST', '/api/v1/areas', { name: '', geometry: polygon(uniqueSquare()) }),
      () =>
        request(kit, alice, 'POST', '/api/v1/areas', {
          name: 'Bowtie',
          geometry: polygon([
            [
              [34.78, 32.08],
              [34.79, 32.09],
              [34.79, 32.08],
              [34.78, 32.09],
              [34.78, 32.08],
            ],
          ]),
        }),
      () => request(kit, bob, 'PATCH', `/api/v1/areas/${area.id}`, { baseVersion: 9, name: 'Ahead' }),
      () => request(kit, bob, 'DELETE', `/api/v1/areas/${area.id}?baseVersion=1`),
      () => request(kit, alice, 'PATCH', `/api/v1/areas/${area.id}`, { baseVersion: 1, name: area.name }),
    ];
    for (const run of failures) {
      const outcome = await observe(run);
      expect(outcome.newEvents, `status ${outcome.statusCode}`).toBe(0);
    }
  });
});

describe('updates, deletes and restores (section 6.3)', () => {
  it('PATCH answers 200 with ETag "v{n}" and the merge flags; a no-op creates no version', async () => {
    const { area } = await createArea(kit, alice, { description: 'first' });
    const response = await request(kit, bob, 'PATCH', `/api/v1/areas/${area.id}`, {
      baseVersion: 1,
      description: null,
    });
    expect(response.statusCode).toBe(200);
    expect(response.headers.etag).toBe('"v2"');
    expect(response.json<AreaMutationResponse>()).toMatchObject({
      area: { version: 2, description: null, updatedBy: { id: bob.id } },
      merged: false,
      noop: false,
      serverChangedFields: [],
    });
    const noop = await request(kit, bob, 'PATCH', `/api/v1/areas/${area.id}`, {
      baseVersion: 2,
      description: '',
    });
    expect(noop.json<AreaMutationResponse>()).toMatchObject({ noop: true, area: { version: 2 } });
    expect(await stored(area.id)).toMatchObject({ version: 2, versions: 2 });
  });

  it('PATCH of an unknown id -> 404 AREA_NOT_FOUND', async () => {
    const response = await request(kit, alice, 'PATCH', `/api/v1/areas/${randomUUID()}`, {
      baseVersion: 1,
      name: 'x',
    });
    expect(response.statusCode).toBe(404);
    expect(problemCode(response)).toBe('AREA_NOT_FOUND');
  });

  it('a geometry PATCH recomputes the measurements', async () => {
    const { area } = await createArea(kit, alice, {
      geometry: polygon(rectangle(34.8, 32.0, 34.801, 32.001)),
    });
    const response = await request(kit, alice, 'PATCH', `/api/v1/areas/${area.id}`, {
      baseVersion: 1,
      geometry: polygon(rectangle(34.8, 32.0, 34.802, 32.001)),
    });
    const updated = response.json<AreaMutationResponse>().area;
    expect(updated.areaKm2 / area.areaKm2).toBeCloseTo(2, 3);
    expect(updated.bbox).toEqual([34.8, 32.0, 34.802, 32.001]);
    expect(updated.name).toBe(area.name);
  });

  it('delete then restore by the creator: tombstone v2, live v3', async () => {
    const { area } = await createArea(kit, alice);
    const deleted = await request(kit, alice, 'DELETE', `/api/v1/areas/${area.id}?baseVersion=1`);
    expect(deleted.statusCode).toBe(200);
    expect(deleted.json<AreaMutationResponse>().area).toMatchObject({
      version: 2,
      deletedBy: { id: alice.id },
    });
    const restored = await request(kit, alice, 'POST', `/api/v1/areas/${area.id}/restore`, {
      baseVersion: 2,
    });
    expect(restored.statusCode).toBe(200);
    expect(restored.json<AreaMutationResponse>().area).toMatchObject({
      version: 3,
      deletedAt: null,
      deletedBy: null,
    });
    expect(restored.headers.etag).toBe('"v3"');
  });
});

describe('an id that is not a uuid', () => {
  it('is a transport 400', async () => {
    const response = await request(kit, alice, 'GET', '/api/v1/areas/not-a-uuid');
    expect(response.statusCode).toBe(400);
    expect(problemCode(response)).toBe('VALIDATION_FAILED');
  });
});

describe('OpenAPI (section 6: every route documents its success schema and each section 6.1 error status)', () => {
  interface Operation {
    summary?: string;
    responses?: Record<string, { content?: Record<string, { schema?: { properties?: object } }> }>;
  }

  const EXPECTED: Record<string, { success: string; errors: string[] }> = {
    'get /api/v1/areas': { success: '200', errors: ['401'] },
    'post /api/v1/areas': { success: '201', errors: ['401', '409', '422'] },
    'get /api/v1/areas/changes': { success: '200', errors: ['401', '410'] },
    'get /api/v1/areas/{id}': { success: '200', errors: ['401', '404'] },
    'patch /api/v1/areas/{id}': { success: '200', errors: ['401', '404', '409', '422', '428'] },
    'delete /api/v1/areas/{id}': { success: '200', errors: ['401', '403', '404', '409', '428'] },
    'post /api/v1/areas/{id}/restore': { success: '200', errors: ['401', '403', '404', '409', '428'] },
    'get /api/v1/areas/{id}/versions': { success: '200', errors: ['401', '404'] },
    'get /api/v1/areas/{id}/versions/{version}': { success: '200', errors: ['401', '404'] },
  };

  it('documents the nine areas operations', async () => {
    const response = await kit.testApp.app.inject({ method: 'GET', url: '/docs/json' });
    expect(response.statusCode).toBe(200);
    const paths = response.json<{ paths: Record<string, Record<string, Operation>> }>().paths;
    for (const [key, expected] of Object.entries(EXPECTED)) {
      const [method = '', path = ''] = key.split(' ');
      const operation = paths[path]?.[method];
      expect(operation?.summary, key).toBeTruthy();
      expect(operation?.responses?.[expected.success], `${key} ${expected.success}`).toBeDefined();
      for (const status of ['400', '429', '500', '503', ...expected.errors]) {
        const schema = operation?.responses?.[status]?.content?.['application/json']?.schema;
        expect(schema?.properties, `${key} ${status}`).toHaveProperty('code');
      }
    }
  });
});
