import type { LightMyRequestResponse } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { fixture } from '../../helpers/fixtures.js';
import { waitFor } from '../../helpers/wait-for.js';
import { createUser } from '../../helpers/users.js';
import type { TestUser } from '../../helpers/users.js';
import { createArea, createAreasKit, polygon, problemCode, request, uniqueSquare } from './areas-kit.js';
import type { AreasKit } from './areas-kit.js';

const DRAW_LIMIT = 50;

let kit: AreasKit;

beforeAll(async () => {
  kit = await createAreasKit({ drawLimit: DRAW_LIMIT });
});

afterAll(async () => {
  await kit.close();
});

function remaining(response: LightMyRequestResponse): number | undefined {
  const header = response.headers['x-draw-ratelimit-remaining'];
  return header === undefined ? undefined : Number(header);
}

function create(user: TestUser, body: Record<string, unknown>): Promise<LightMyRequestResponse> {
  return request(kit, user, 'POST', '/api/v1/areas', body);
}

describe('drawing-action charge (section 6.3 step 3, section 10.1)', () => {
  it('a 422, a sanitation 400 and a 428 each cost one action; a transport 400 is free', async () => {
    const user = await createUser(kit.testApp.container);
    const valid = await create(user, { name: 'ok', geometry: polygon(uniqueSquare()) });
    expect(valid.statusCode).toBe(201);
    expect(remaining(valid)).toBe(DRAW_LIMIT - 1);

    const invalidGeometry = await create(user, {
      name: 'bowtie',
      geometry: fixture('bowtie_self_intersection').geojson,
    });
    expect(invalidGeometry.statusCode).toBe(422);
    expect(remaining(invalidGeometry)).toBe(DRAW_LIMIT - 2);

    const emptyName = await create(user, { name: '   ', geometry: polygon(uniqueSquare()) });
    expect(emptyName.statusCode).toBe(400);
    expect(problemCode(emptyName)).toBe('VALIDATION_FAILED');
    expect(remaining(emptyName)).toBe(DRAW_LIMIT - 3);

    const transport = await create(user, { name: 'x', geometry: polygon(uniqueSquare()), unknown: true });
    expect(transport.statusCode).toBe(400);
    expect(remaining(transport)).toBeUndefined();

    const { area } = (await create(user, { name: 'next', geometry: polygon(uniqueSquare()) })).json<{
      area: { id: string };
    }>();
    const precondition = await request(kit, user, 'PATCH', `/api/v1/areas/${area.id}`, { name: 'y' });
    expect(precondition.statusCode).toBe(428);
    expect(remaining(precondition)).toBe(DRAW_LIMIT - 5);
  });

  it('the 51st mutation in the window -> 429 RATE_LIMITED with Retry-After and X-Draw-RateLimit-*', async () => {
    const user = await createUser(kit.testApp.container);
    for (let index = 0; index < DRAW_LIMIT; index += 1) {
      const response = await create(user, { name: `n${index}`, geometry: polygon(uniqueSquare()) });
      expect(response.statusCode).toBe(201);
      expect(remaining(response)).toBe(DRAW_LIMIT - index - 1);
    }
    const eventsBefore = kit.events.length;
    const limited = await create(user, { name: 'one too many', geometry: polygon(uniqueSquare()) });
    expect(limited.statusCode).toBe(429);
    expect(limited.headers['content-type']).toContain('application/problem+json');
    expect(Number(limited.headers['retry-after'])).toBeGreaterThanOrEqual(1);
    expect(limited.headers['x-draw-ratelimit-limit']).toBe(String(DRAW_LIMIT));
    expect(limited.headers['x-draw-ratelimit-remaining']).toBe('0');
    expect(Number(limited.headers['x-draw-ratelimit-reset'])).toBeGreaterThanOrEqual(1);
    expect(limited.json<Record<string, unknown>>()).toMatchObject({
      code: 'RATE_LIMITED',
      scope: 'draw',
      limit: DRAW_LIMIT,
    });
    expect(kit.events).toHaveLength(eventsBefore);

    // Every mutation kind is charged against the same budget.
    const other = await createArea(kit, await createUser(kit.testApp.container));
    const patch = await request(kit, user, 'PATCH', `/api/v1/areas/${other.area.id}`, {
      baseVersion: 1,
      name: 'x',
    });
    const remove = await request(kit, user, 'DELETE', `/api/v1/areas/${other.area.id}?baseVersion=1`);
    const restore = await request(kit, user, 'POST', `/api/v1/areas/${other.area.id}/restore`, {
      baseVersion: 1,
    });
    expect([patch.statusCode, remove.statusCode, restore.statusCode]).toEqual([429, 429, 429]);

    // The rejection is audited once through the coalescer (not as an area.* failure row).
    await waitFor(
      () =>
        kit.audit.find((event) => event.action === 'ratelimit.hit' && event.actorId === user.id).length > 0,
    );
    expect(
      kit.audit.find(
        (event) =>
          event.action.startsWith('area.') && event.actorId === user.id && event.outcome !== 'success',
      ),
    ).toEqual([]);
  });
});
