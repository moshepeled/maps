/**
 * Shared harness of the areas integration suites: an app with only the areas module, an in-memory audit logger to
 * assert on, and an in-memory drawing limiter so a suite can pick its own limit (section 3.3). Cache, bus and draft registry
 * are the production Redis ones; the bus's local delivery is synchronous, which is exactly what the
 * publish-before-reply assertions observe.
 */
import { quantize } from '@snapland/shared';
import type { AreaMutationResponse, PolygonCoordinates } from '@snapland/shared';
import type { LightMyRequestResponse } from 'fastify';
import { expect } from 'vitest';

import type { AppConfigInput } from '../../../src/config/env.js';
import type { InMemoryAuditLogger } from '../../../src/infra/audit/in-memory.js';
import { systemClock } from '../../../src/infra/clock.js';
import type { AreasBusPayload } from '../../../src/infra/events/payloads.js';
import { InMemoryDrawRateLimiter } from '../../../src/infra/ratelimit/in-memory.js';
import { createAreasModule } from '../../../src/modules/areas/index.js';
import { createMemoryAudit } from '../../helpers/audit.js';
import { createTestApp, nextInstanceId, testConfig } from '../../helpers/test-app.js';
import type { TestApp } from '../../helpers/test-app.js';
import { bearer } from '../../helpers/users.js';
import type { TestUser } from '../../helpers/users.js';

export interface AreasKit {
  testApp: TestApp;
  audit: InMemoryAuditLogger;
  /** Every `areas` bus event received by a local subscriber, in order. */
  events: AreasBusPayload[];
  close(): Promise<void>;
}

export interface AreasKitOptions {
  config?: AppConfigInput;
  /** Drawing actions per window (default: high, so suites never hit it by volume). */
  drawLimit?: number;
}

export async function createAreasKit(options: AreasKitOptions = {}): Promise<AreasKit> {
  const instanceId = nextInstanceId();
  const config = testConfig(options.config, instanceId);
  const audit = createMemoryAudit();
  const drawRateLimiter = new InMemoryDrawRateLimiter({
    limit: options.drawLimit ?? 100_000,
    windowMs: config.DRAW_RATE_LIMIT_WINDOW_MS,
    clock: systemClock,
  });
  const testApp = await createTestApp({
    instanceId,
    ...(options.config === undefined ? {} : { config: options.config }),
    modules: [createAreasModule],
    overrides: { audit, drawRateLimiter },
  });
  const events: AreasBusPayload[] = [];
  const unsubscribe = testApp.container.events.subscribe('areas', (message) => {
    events.push(message.payload);
  });
  return {
    testApp,
    audit,
    events,
    async close() {
      unsubscribe();
      await testApp.close();
    },
  };
}

// -- Geometry helpers ------------------------------------------------------------------------------------------

/** A closed counter-clockwise axis-aligned rectangle. */
export function rectangle(west: number, south: number, east: number, north: number): PolygonCoordinates {
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

export function polygon(coordinates: PolygonCoordinates): {
  type: 'Polygon';
  coordinates: PolygonCoordinates;
} {
  return { type: 'Polygon', coordinates };
}

/** A unique ~50 m square near Tel Aviv (each call shifts it, so tests never share geometry by accident). */
let squareCounter = 0;
export function uniqueSquare(): PolygonCoordinates {
  squareCounter += 1;
  // Quantised like stored geometry, so request and response coordinates compare exactly.
  const west = quantize(34.7 + (squareCounter % 200) * 0.001, 7);
  const south = quantize(32.0 + Math.floor(squareCounter / 200) * 0.001, 7);
  return rectangle(west, south, quantize(west + 0.0005, 7), quantize(south + 0.0005, 7));
}

// -- HTTP helpers ----------------------------------------------------------------------------------------------

type InjectMethod = 'GET' | 'POST' | 'PATCH' | 'DELETE';

export function request(
  kit: AreasKit,
  user: TestUser,
  method: InjectMethod,
  url: string,
  payload?: unknown,
  headers: Record<string, string> = {},
): Promise<LightMyRequestResponse> {
  return kit.testApp.app.inject({
    method,
    url,
    headers: { ...bearer(user), ...headers },
    ...(payload === undefined ? {} : { payload: payload as Record<string, unknown> }),
  });
}

export interface CreateBody {
  id?: string;
  name?: string;
  description?: string | null;
  geometry?: unknown;
}

/** POST /api/v1/areas with sensible defaults; asserts 201 and returns the response body. */
export async function createArea(
  kit: AreasKit,
  user: TestUser,
  body: CreateBody = {},
): Promise<AreaMutationResponse> {
  const response = await request(kit, user, 'POST', '/api/v1/areas', {
    name: 'Test area',
    geometry: polygon(uniqueSquare()),
    ...body,
  });
  expect(response.statusCode, response.body).toBe(201);
  return response.json<AreaMutationResponse>();
}

export function problemCode(response: LightMyRequestResponse): string {
  return response.json<{ code: string }>().code;
}
