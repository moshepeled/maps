import { randomUUID } from 'node:crypto';

import type { Position } from '@snapland/shared';
import type { LightMyRequestResponse } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { fixture, loadFixtures } from '../../helpers/fixtures.js';
import { bearer, createUser } from '../../helpers/users.js';
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

let kit: AreasKit;
let alice: TestUser;

beforeAll(async () => {
  kit = await createAreasKit();
  alice = await createUser(kit.testApp.container);
});

afterAll(async () => {
  await kit.close();
});

interface GeometryProblem {
  code: string;
  errors: { code: string; path: string; location?: Position }[];
}

function post(body: unknown): Promise<LightMyRequestResponse> {
  return request(kit, alice, 'POST', '/api/v1/areas', body);
}

function expectInvalidGeometry(response: LightMyRequestResponse, subCode: string): GeometryProblem {
  expect(response.statusCode, response.body).toBe(422);
  expect(response.headers['content-type']).toContain('application/problem+json');
  const problem = response.json<GeometryProblem>();
  expect(problem.code).toBe('INVALID_GEOMETRY');
  expect(problem.errors.map((issue) => issue.code)).toContain(subCode);
  return problem;
}

function expectTransport400(response: LightMyRequestResponse): void {
  expect(response.statusCode, response.body).toBe(400);
  expect(problemCode(response)).toBe('VALIDATION_FAILED');
}

const SQUARE = fixture('tel_aviv_1km_square').geojson.coordinates;

/** A square with `rings - 1` small holes (each hole valid on its own; the ring count fails first). */
function withHoles(rings: number): Position[][] {
  const holes = Array.from({ length: rings - 1 }, (_, index) => {
    const west = 34.781 + index * 0.0008;
    return rectangle(west, 32.081, west + 0.0004, 32.0814)[0] ?? [];
  });
  return [SQUARE[0] ?? [], ...holes];
}

/** A closed ring with `total` positions (closing position included) on a circle. */
function ringWithPositions(total: number): Position[] {
  const ring = Array.from({ length: total - 1 }, (_, index): Position => {
    const angle = (2 * Math.PI * index) / (total - 1);
    return [34.8 + 0.01 * Math.cos(angle), 32.1 + 0.01 * Math.sin(angle)];
  });
  return [...ring, ring[0] ?? [0, 0]];
}

describe('domain geometry stages -> 422 INVALID_GEOMETRY with the section 9.2 sub-code', () => {
  const expected: Record<string, string> = {
    bowtie_self_intersection: 'SELF_INTERSECTION',
    unclosed_ring: 'RING_NOT_CLOSED',
    too_few_points: 'TOO_FEW_POSITIONS',
    duplicate_points_only: 'TOO_FEW_POSITIONS',
    spike: 'SELF_INTERSECTION',
  };

  it('each section 9.3 invalid fixture passes transport and returns 422 with its sub-code', async () => {
    expect(
      loadFixtures()
        .invalid_polygons.map((entry) => entry.name)
        .sort(),
    ).toEqual(Object.keys(expected).sort());
    for (const entry of loadFixtures().invalid_polygons) {
      const response = await post({ name: entry.name, geometry: entry.geojson });
      expectInvalidGeometry(response, expected[entry.name] ?? 'unknown');
    }
  });

  it('reports the bowtie crossing location', async () => {
    const problem = expectInvalidGeometry(
      await post({ name: 'bowtie', geometry: fixture('bowtie_self_intersection').geojson }),
      'SELF_INTERSECTION',
    );
    expect(problem.errors[0]?.location).toEqual([34.785, 32.085]);
  });

  it('a Polygon-shaped type "MultiPolygon" -> INVALID_GEOMETRY_TYPE', async () => {
    expectInvalidGeometry(
      await post({ name: 'typed', geometry: { type: 'MultiPolygon', coordinates: SQUARE } }),
      'INVALID_GEOMETRY_TYPE',
    );
  });

  it('12 rings -> TOO_MANY_RINGS; 2,001 positions -> TOO_MANY_VERTICES', async () => {
    expectInvalidGeometry(await post({ name: 'rings', geometry: polygon(withHoles(12)) }), 'TOO_MANY_RINGS');
    expectInvalidGeometry(
      await post({ name: 'vertices', geometry: polygon([ringWithPositions(2001)]) }),
      'TOO_MANY_VERTICES',
    );
    // The same shapes one step below the limits are accepted.
    expect((await post({ name: 'rings ok', geometry: polygon(withHoles(11)) })).statusCode).toBe(201);
    expect(
      (await post({ name: 'vertices ok', geometry: polygon([ringWithPositions(2000)]) })).statusCode,
    ).toBe(201);
  });

  it('lat 86 -> COORDINATE_OUT_OF_RANGE', async () => {
    expectInvalidGeometry(
      await post({ name: 'north', geometry: polygon(rectangle(34.7, 85.9, 34.8, 86)) }),
      'COORDINATE_OUT_OF_RANGE',
    );
  });

  it('a PATCH with an invalid geometry -> 422', async () => {
    const { area } = await createArea(kit, alice);
    const response = await request(kit, alice, 'PATCH', `/api/v1/areas/${area.id}`, {
      baseVersion: 1,
      geometry: fixture('spike').geojson,
    });
    expectInvalidGeometry(response, 'SELF_INTERSECTION');
  });
});

describe('transport failures -> 400 VALIDATION_FAILED (stage 0)', () => {
  it('a genuine MultiPolygon nesting', async () => {
    expectTransport400(
      await post({ name: 'multi', geometry: { type: 'MultiPolygon', coordinates: [SQUARE] } }),
    );
  });

  it('a 3-number position', async () => {
    const ring = (SQUARE[0] ?? []).map(([lng, lat]) => [lng, lat, 0]);
    expectTransport400(await post({ name: '3d', geometry: { type: 'Polygon', coordinates: [ring] } }));
  });

  it('1e999 (parsed to Infinity)', async () => {
    const payload =
      '{"name":"inf","geometry":{"type":"Polygon","coordinates":[[[1e999,32.08],[34.79,32.08],[34.79,32.09],[34.78,32.08]]]}}';
    const response = await kit.testApp.app.inject({
      method: 'POST',
      url: '/api/v1/areas',
      headers: { ...bearer(alice), 'content-type': 'application/json' },
      payload,
    });
    expectTransport400(response);
  });

  it('an unknown key, and baseVersion as a string', async () => {
    expectTransport400(await post({ name: 'x', geometry: polygon(uniqueSquare()), color: 'red' }));
    const { area } = await createArea(kit, alice);
    expectTransport400(
      await request(kit, alice, 'PATCH', `/api/v1/areas/${area.id}`, { baseVersion: '1', name: 'y' }),
    );
    expectTransport400(await request(kit, alice, 'PATCH', `/api/v1/areas/${area.id}`, { baseVersion: 1 }));
  });
});

describe('text sanitation -> 400 VALIDATION_FAILED on the field (after transport, so it costs an action)', () => {
  it.each([
    ['empty', ''],
    ['only whitespace and invisible characters', ' ​\t‮ '],
    ['longer than 120 code points', 'x'.repeat(121)],
  ])('name %s', async (_label, name) => {
    const response = await post({ name, geometry: polygon(uniqueSquare()) });
    expectTransport400(response);
    expect(response.json<{ errors: { path: string }[] }>().errors[0]?.path).toBe('name');
  });

  it('a description longer than 2,000 code points', async () => {
    const response = await post({
      name: 'ok',
      description: 'd'.repeat(2001),
      geometry: polygon(uniqueSquare()),
    });
    expectTransport400(response);
    expect(response.json<{ errors: { path: string }[] }>().errors[0]?.path).toBe('description');
  });

  it('keeps legitimate characters (Hebrew with RLM, markup) and strips bidi overrides', async () => {
    const { area } = await createArea(kit, alice, {
      name: 'כיכר‏ רבין ‮<b>&',
      description: 'line 1\r\nline 2',
    });
    expect(area.name).toBe('כיכר‏ רבין <b>&');
    expect(area.description).toBe('line 1\nline 2');
  });
});

describe('preconditions -> 428 PRECONDITION_REQUIRED', () => {
  it('PATCH, DELETE and restore without baseVersion', async () => {
    const { area } = await createArea(kit, alice);
    const patch = await request(kit, alice, 'PATCH', `/api/v1/areas/${area.id}`, { name: 'x' });
    const remove = await request(kit, alice, 'DELETE', `/api/v1/areas/${area.id}`);
    const restore = await request(kit, alice, 'POST', `/api/v1/areas/${area.id}/restore`, {});
    for (const response of [patch, remove, restore]) {
      expect(response.statusCode, response.body).toBe(428);
      expect(problemCode(response)).toBe('PRECONDITION_REQUIRED');
    }
  });

  it('the sanitation 400 comes before the 428 (normative order)', async () => {
    const { area } = await createArea(kit, alice);
    const response = await request(kit, alice, 'PATCH', `/api/v1/areas/${area.id}`, { name: '' });
    expectTransport400(response);
  });
});

describe('GEOS / database CHECK -> 422 (stage 13, the third line of defence)', () => {
  it('a CHECK violation while writing is 422 INVALID_GEOMETRY (GEOS_INVALID), not 500', async () => {
    const pool = kit.testApp.container.db.pool;
    // A throwaway geometry CHECK on this run's own database: 6 stored points (5 vertices + closing) violate it.
    await pool.query(
      'ALTER TABLE areas ADD CONSTRAINT areas_geom_it_probe_ck CHECK (ST_NPoints(geom) <> 6) NOT VALID',
    );
    try {
      const pentagon: Position[] = [
        [34.9, 32.2],
        [34.901, 32.2],
        [34.9015, 32.2008],
        [34.9005, 32.2015],
        [34.8995, 32.2008],
        [34.9, 32.2],
      ];
      const id = randomUUID();
      const response = await post({ id, name: 'probe', geometry: polygon([pentagon]) });
      const problem = expectInvalidGeometry(response, 'GEOS_INVALID');
      expect(problem.errors[0]?.path).toBe('geometry');
      expect(JSON.stringify(problem)).toContain('areas_geom_it_probe_ck');
      expect((await request(kit, alice, 'GET', `/api/v1/areas/${id}?includeDeleted=true`)).statusCode).toBe(
        404,
      );
    } finally {
      await pool.query('ALTER TABLE areas DROP CONSTRAINT IF EXISTS areas_geom_it_probe_ck');
    }
  });
});
