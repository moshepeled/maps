/**
 * System test (SPEC section 12.3, R40; task T9): two fully wired app instances in one process with the PRODUCTION
 * infrastructure - no container overrides, so the Redis event bus, the Redis draw limiter, the epoch-safe L1 + gzip L2
 * bbox cache, the buffered audit writer and the Redis draft registry are the real ones - sharing PostgreSQL and Redis.
 *
 * Proves the seams between the areas (T2), realtime (T3) and platform (T4) modules:
 * - a REST mutation on instance A reaches a WebSocket client of instance B as `area.changed` within 500 ms of the
 *   request starting, carrying exactly the state the REST reply returned (same version, changeSeq and areaKm2);
 * - a client of B whose viewport does not intersect receives nothing;
 * - a bbox read served by B right after the 201 already contains the new area, although B had cached that region just
 *   before: the writer bumps the cache generations in the shared Redis before it replies (section 10.2 step 6).
 */
import { randomUUID } from 'node:crypto';

import { quantize } from '@snapland/shared';
import type {
  AreaDto,
  AreaListResponse,
  AreaMutationResponse,
  Bbox,
  PolygonCoordinates,
} from '@snapland/shared';
import type { LightMyRequestResponse } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createTestApp } from '../../helpers/test-app.js';
import type { TestApp } from '../../helpers/test-app.js';
import { bearer, createUser } from '../../helpers/users.js';
import type { TestUser } from '../../helpers/users.js';
import { waitFor } from '../../helpers/wait-for.js';
import {
  EILAT_VIEWPORT,
  FAST_REALTIME,
  TEL_AVIV_VIEWPORT,
  connectUser,
  delay,
} from '../realtime/realtime-harness.js';
import type { ServerMessage, WsClient } from '../realtime/realtime-harness.js';

/** SPEC section 12.3 / R40: REST commit on A -> `area.changed` on a WS client of B. */
const FANOUT_BUDGET_MS = 500;
/** How long a non-intersecting client is watched for a message it must never get. */
const SILENCE_WINDOW_MS = 300;
/** The Tel Aviv viewport as a bbox query parameter (inside the 8,192 px span cap at zoom 15). */
const TEL_AVIV_BBOX_PARAM = TEL_AVIV_VIEWPORT.join(',');

let instanceA: TestApp;
let instanceB: TestApp;
let alice: TestUser;
let bob: TestUser;
let carol: TestUser;
const openClients: WsClient[] = [];

beforeAll(async () => {
  // No `overrides`: every infra component is the one production wires through its index.ts factory.
  [instanceA, instanceB] = await Promise.all([
    createTestApp({ config: FAST_REALTIME }),
    createTestApp({ config: FAST_REALTIME }),
  ]);
  [alice, bob, carol] = await Promise.all([
    createUser(instanceA.container, { displayName: 'Alice' }),
    createUser(instanceA.container, { displayName: 'Bob' }),
    createUser(instanceA.container, { displayName: 'Carol' }),
  ]);
});

afterAll(async () => {
  await Promise.all(openClients.map((client) => client.close()));
  await Promise.all([instanceA.close(), instanceB.close()]);
});

async function connect(app: TestApp, user: TestUser, viewport: Bbox): Promise<WsClient> {
  const client = await connectUser(app, user, { viewport });
  openClients.push(client);
  return client;
}

/** A unique ~50 m square inside the Tel Aviv viewport, quantized like stored geometry (7 dp). */
let squareCounter = 0;
function uniqueTelAvivSquare(): PolygonCoordinates {
  squareCounter += 1;
  const west = quantize(34.77 + squareCounter * 0.001, 7);
  const south = quantize(32.07 + squareCounter * 0.001, 7);
  const east = quantize(west + 0.0005, 7);
  const north = quantize(south + 0.0005, 7);
  return [
    [
      [west, south],
      [east, south],
      [east, north],
      [west, north],
      [west, south],
    ],
  ];
}

function send(
  app: TestApp,
  user: TestUser,
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
  url: string,
  payload?: Record<string, unknown>,
): Promise<LightMyRequestResponse> {
  return app.app.inject({
    method,
    url,
    headers: bearer(user),
    ...(payload === undefined ? {} : { payload }),
  });
}

function isAreaChanged(areaId: string, op: string) {
  return (message: ServerMessage): boolean =>
    message.type === 'area.changed' &&
    message.data['op'] === op &&
    (message.data['area'] as { id: string } | undefined)?.id === areaId;
}

/**
 * Resolves with the monotonic time at which the first message matching `predicate` arrived. The harness's own
 * listener was attached first, so `client.messages` already holds the new (unbatched) messages when this one runs.
 */
function arrivalTime(client: WsClient, predicate: (message: ServerMessage) => boolean): Promise<number> {
  return new Promise((resolve) => {
    const onMessage = (): void => {
      if (!client.messages.some(predicate)) return;
      client.socket.off('message', onMessage);
      resolve(performance.now());
    };
    client.socket.on('message', onMessage);
  });
}

/** Runs a REST call on A and measures when B's client received the matching `area.changed`. */
async function mutateAndMeasure(
  viewer: WsClient,
  predicateFor: (areaId: string) => (message: ServerMessage) => boolean,
  areaId: string,
  mutation: () => Promise<LightMyRequestResponse>,
): Promise<{ response: LightMyRequestResponse; message: ServerMessage; fanoutMs: number }> {
  const predicate = predicateFor(areaId);
  const arrived = arrivalTime(viewer, predicate);
  const startedAt = performance.now();
  const response = await mutation();
  const receivedAt = await Promise.race([arrived, delay(2000).then(() => Number.POSITIVE_INFINITY)]);
  const message = viewer.messages.find(predicate);
  if (message === undefined) throw new Error(`no area.changed for ${areaId} on instance B`);
  return { response, message, fanoutMs: receivedAt - startedAt };
}

/** Evidence for the T9 report: the measured REST -> WS latency of each mutation. */
function report(op: string, fanoutMs: number): void {
  process.stdout.write(
    `[cross-instance-rest-ws] ${op}: REST on A → area.changed on B in ${fanoutMs.toFixed(1)} ms\n`,
  );
}

describe('REST on instance A -> WebSocket on instance B (production infra)', () => {
  it('delivers area.changed for a create within 500 ms with the state of the 201, and nothing outside the view', async () => {
    expect(instanceA.container.instanceId).not.toBe(instanceB.container.instanceId);
    const viewer = await connect(instanceB, bob, TEL_AVIV_VIEWPORT);
    const elsewhere = await connect(instanceB, carol, EILAT_VIEWPORT);
    const id = randomUUID();

    const { response, message, fanoutMs } = await mutateAndMeasure(
      viewer,
      (areaId) => isAreaChanged(areaId, 'create'),
      id,
      () =>
        send(instanceA, alice, 'POST', '/api/v1/areas', {
          id,
          name: 'Cross-instance create',
          geometry: { type: 'Polygon', coordinates: uniqueTelAvivSquare() },
        }),
    );

    expect(response.statusCode, response.body).toBe(201);
    const created = response.json<AreaMutationResponse>().area;
    report('create', fanoutMs);
    expect(fanoutMs).toBeLessThanOrEqual(FANOUT_BUDGET_MS);
    expect(message.data).toMatchObject({
      op: 'create',
      changeSeq: created.changeSeq,
      merged: false,
      actor: { id: alice.id, displayName: 'Alice' },
    });
    // The event carries exactly what the REST reply returned, so both clients agree on the area (R31).
    expect(message.data['area']).toEqual(created);

    await delay(SILENCE_WINDOW_MS);
    expect(elsewhere.messages.some(isAreaChanged(id, 'create'))).toBe(false);
  });

  it('delivers the update and the delete of that area as well, each within 500 ms', async () => {
    const viewer = await connect(instanceB, bob, TEL_AVIV_VIEWPORT);
    const id = randomUUID();
    const createResponse = await send(instanceA, alice, 'POST', '/api/v1/areas', {
      id,
      name: 'Before rename',
      geometry: { type: 'Polygon', coordinates: uniqueTelAvivSquare() },
    });
    expect(createResponse.statusCode, createResponse.body).toBe(201);

    const renamed = await mutateAndMeasure(
      viewer,
      (areaId) => isAreaChanged(areaId, 'update'),
      id,
      () => send(instanceA, alice, 'PATCH', `/api/v1/areas/${id}`, { baseVersion: 1, name: 'After rename' }),
    );
    expect(renamed.response.statusCode, renamed.response.body).toBe(200);
    report('update', renamed.fanoutMs);
    expect(renamed.fanoutMs).toBeLessThanOrEqual(FANOUT_BUDGET_MS);
    expect(renamed.message.data).toMatchObject({
      op: 'update',
      changedFields: ['name'],
      previousName: 'Before rename',
      area: { id, version: 2, name: 'After rename' },
    });

    const deleted = await mutateAndMeasure(
      viewer,
      (areaId) => isAreaChanged(areaId, 'delete'),
      id,
      () => send(instanceA, alice, 'DELETE', `/api/v1/areas/${id}?baseVersion=2`),
    );
    expect(deleted.response.statusCode, deleted.response.body).toBe(200);
    report('delete', deleted.fanoutMs);
    expect(deleted.fanoutMs).toBeLessThanOrEqual(FANOUT_BUDGET_MS);
    const deletedArea = deleted.message.data['area'] as AreaDto;
    expect(deletedArea.deletedAt).not.toBeNull();
    expect(deletedArea.deletedBy?.id).toBe(alice.id);
  });
});

describe('bbox reads on instance B after a write on instance A (production L1 + L2 cache)', () => {
  const bboxUrl = `/api/v1/areas?bbox=${TEL_AVIV_BBOX_PARAM}&zoom=15`;

  /** Repeats the read on B until B serves it from its L1 (the first read of a fresh prefix bypasses: no epoch yet). */
  function cachedOnB(): Promise<LightMyRequestResponse> {
    return waitFor(
      async () => {
        const response = await send(instanceB, bob, 'GET', bboxUrl);
        expect(response.statusCode, response.body).toBe(200);
        return response.headers['x-cache'] === 'HIT-L1' ? response : null;
      },
      { timeoutMs: 2000, description: 'bbox page cached on B' },
    );
  }

  it('never serve B’s cached page without the area created on A', async () => {
    const before = await cachedOnB();

    const id = randomUUID();
    const created = await send(instanceA, alice, 'POST', '/api/v1/areas', {
      id,
      name: 'Read-after-write probe',
      geometry: { type: 'Polygon', coordinates: uniqueTelAvivSquare() },
    });
    expect(created.statusCode, created.body).toBe(201);
    const { area } = created.json<AreaMutationResponse>();

    // Immediately after the 201, with no wait: the generations were bumped in the shared Redis before the reply.
    const fresh = await send(instanceB, bob, 'GET', bboxUrl);
    expect(fresh.statusCode, fresh.body).toBe(200);
    expect(fresh.headers['x-cache']).not.toBe('HIT-L1');
    const page = fresh.json<AreaListResponse>();
    const item = page.items.find((candidate) => candidate.id === id);
    expect(item?.areaKm2).toBe(area.areaKm2);
    expect(page.asOfChangeSeq).toBeGreaterThanOrEqual(area.changeSeq);
    expect(before.json<AreaListResponse>().items.some((candidate) => candidate.id === id)).toBe(false);

    // The next identical read on B is served from its cache again, now with the area.
    const rewarmed = await cachedOnB();
    expect(rewarmed.json<AreaListResponse>().items.some((candidate) => candidate.id === id)).toBe(true);
  });
});
