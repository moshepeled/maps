import { describe, expect, it } from 'vitest';

import { LIMITS } from '../constants.js';
import { validatePolygon } from '../geo/validate.js';
import { invalidFixtures, validFixture, validFixtures } from '../testing/fixtures.js';
import { AuditLogQuerySchema, AuditStatsResponseSchema } from './admin.js';
import {
  AreaBboxQuerySchema,
  AreaDtoSchema,
  AreaVersionParamsSchema,
  ChangeFeedQuerySchema,
  CreateAreaRequestSchema,
  DeleteAreaQuerySchema,
  PolygonGeometryInSchema,
  RestoreAreaRequestSchema,
  UpdateAreaRequestSchema,
} from './areas.js';
import { LoginRequestSchema, RegisterRequestSchema, UsernameSchema, WsTicketResponseSchema } from './auth.js';
import { ClientErrorReportSchema } from './client-errors.js';
import { UserRefSchema } from './common.js';
import { ConfigResponseSchema } from './config.js';
import { ReadyResponseSchema } from './health.js';
import { ProblemSchema } from './problem.js';

const square = validFixture('tel_aviv_1km_square').geojson;

describe('PolygonGeometryIn (transport, stage 0)', () => {
  it('accepts every section 9.3 fixture, valid and invalid, so domain failures are 422 and never 400', () => {
    for (const fixture of [...validFixtures(), ...invalidFixtures()]) {
      expect(PolygonGeometryInSchema.safeParse(fixture.geojson).success, fixture.name).toBe(true);
    }
  });

  it('passes a Polygon-shaped MultiPolygon, 12 rings and 2,001 positions to the domain validator (422 sub-codes)', () => {
    const cases = [
      { geometry: { type: 'MultiPolygon', coordinates: square.coordinates }, code: 'INVALID_GEOMETRY_TYPE' },
      {
        geometry: {
          type: 'Polygon',
          coordinates: Array.from({ length: 12 }, () => square.coordinates[0] ?? []),
        },
        code: 'TOO_MANY_RINGS',
      },
      {
        geometry: {
          type: 'Polygon',
          coordinates: [
            [
              ...Array.from({ length: 2000 }, (_, i): [number, number] => [34.78 + i * 1e-5, 32.08]),
              [34.78, 32.08],
            ],
          ],
        },
        code: 'TOO_MANY_VERTICES',
      },
    ];
    for (const { geometry, code } of cases) {
      expect(PolygonGeometryInSchema.safeParse(geometry).success, code).toBe(true);
      const result = validatePolygon(geometry);
      expect(result.ok ? null : result.issues[0]?.code).toBe(code);
    }
  });

  it('rejects a genuine MultiPolygon nesting, a 3-number position, Infinity, 1e999 and > 10,000 positions', () => {
    const multi = { type: 'MultiPolygon', coordinates: [square.coordinates] };
    const threeNumbers = {
      type: 'Polygon',
      coordinates: [
        [
          [34.78, 32.08, 10],
          [34.79, 32.08],
          [34.79, 32.09],
          [34.78, 32.08],
        ],
      ],
    };
    const infinity = {
      type: 'Polygon',
      coordinates: [
        [
          [Number.POSITIVE_INFINITY, 32.08],
          [34.79, 32.08],
          [34.79, 32.09],
          [34.78, 32.08],
        ],
      ],
    };
    const parsedHuge: unknown = JSON.parse(
      '{"type":"Polygon","coordinates":[[[1e999,32.08],[34.79,32.08],[34.79,32.09],[34.78,32.08]]]}',
    );
    const tooMany = {
      type: 'Polygon',
      coordinates: [Array.from({ length: 5001 }, () => [0, 0]), Array.from({ length: 5001 }, () => [0, 0])],
    };
    const tooManyInOneRing = { type: 'Polygon', coordinates: [Array.from({ length: 10_001 }, () => [0, 0])] };
    for (const geometry of [multi, threeNumbers, infinity, parsedHuge, tooMany, tooManyInOneRing]) {
      expect(PolygonGeometryInSchema.safeParse(geometry).success).toBe(false);
    }
    expect(PolygonGeometryInSchema.safeParse({ type: 'Polygon', coordinates: [], extra: 1 }).success).toBe(
      false,
    );
  });
});

describe('area request schemas', () => {
  it('create: strict object, raw text caps only (sanitation happens in the service)', () => {
    expect(CreateAreaRequestSchema.safeParse({ name: '  ', geometry: square }).success).toBe(true);
    expect(CreateAreaRequestSchema.safeParse({ name: 'x', geometry: square, color: 'red' }).success).toBe(
      false,
    );
    expect(CreateAreaRequestSchema.safeParse({ name: 'x'.repeat(481), geometry: square }).success).toBe(
      false,
    );
    expect(CreateAreaRequestSchema.safeParse({ id: 'not-a-uuid', name: 'x', geometry: square }).success).toBe(
      false,
    );
  });

  it('baseVersion is optional in update, restore and delete (its absence is a 428 from the service)', () => {
    expect(UpdateAreaRequestSchema.safeParse({ name: 'Park' }).success).toBe(true);
    expect(RestoreAreaRequestSchema.safeParse({}).success).toBe(true);
    expect(DeleteAreaQuerySchema.safeParse({}).success).toBe(true);
    expect(DeleteAreaQuerySchema.parse({ baseVersion: '3' })).toEqual({ baseVersion: 3 });
    expect(UpdateAreaRequestSchema.safeParse({ baseVersion: '3', name: 'x' }).success).toBe(false);
    expect(UpdateAreaRequestSchema.safeParse({ baseVersion: 3 }).success).toBe(false);
  });

  it('bounds the bbox query as a string and coerces numbers', () => {
    expect(AreaBboxQuerySchema.parse({ bbox: '34.7,31.95,34.95,32.2', zoom: '14', limit: '2000' })).toEqual({
      bbox: '34.7,31.95,34.95,32.2',
      zoom: 14,
      limit: 2000,
    });
    expect(AreaBboxQuerySchema.safeParse({ bbox: 'x'.repeat(121), zoom: '14' }).success).toBe(false);
    expect(AreaBboxQuerySchema.safeParse({ bbox: '1,2,3,4', zoom: '23' }).success).toBe(false);
    expect(AreaBboxQuerySchema.safeParse({ bbox: '1,2,3,4', zoom: '14', limit: '2001' }).success).toBe(false);
    expect(ChangeFeedQuerySchema.parse({ since: '1040' })).toEqual({ since: 1040 });
    expect(
      AreaVersionParamsSchema.safeParse({ id: '7d7a4c52-9a0b-4e0f-b3c1-2e5f6a7b8c9d', version: '0' }).success,
    ).toBe(false);
  });
});

describe('response schemas', () => {
  it('requires UserRef.color', () => {
    expect(
      UserRefSchema.safeParse({ id: '3f6c1a2e-0b1d-4c55-9a0e-7c1d2b3a4f50', displayName: 'Alice' }).success,
    ).toBe(false);
    expect(
      UserRefSchema.safeParse({
        id: '3f6c1a2e-0b1d-4c55-9a0e-7c1d2b3a4f50',
        displayName: 'Alice',
        color: '#C44F9D',
      }).success,
    ).toBe(false);
    expect(
      UserRefSchema.safeParse({
        id: '3f6c1a2e-0b1d-4c55-9a0e-7c1d2b3a4f50',
        displayName: 'Alice',
        color: '#c44f9d',
      }).success,
    ).toBe(true);
  });

  it('parses a full AreaDto', () => {
    const alice = { id: '3f6c1a2e-0b1d-4c55-9a0e-7c1d2b3a4f50', displayName: 'Alice', color: '#c44f9d' };
    const dto = {
      id: '7d7a4c52-9a0b-4e0f-b3c1-2e5f6a7b8c9d',
      name: 'Rabin Square',
      description: null,
      geometry: square,
      areaKm2: 0.9987007904701233,
      perimeterKm: 3.997,
      vertexCount: 4,
      bbox: [34.78, 32.08, 34.7906, 32.089],
      version: 3,
      changeSeq: 1042,
      createdBy: alice,
      updatedBy: alice,
      createdAt: '2026-09-27T10:00:00.000Z',
      updatedAt: '2026-09-27T10:05:00.000Z',
      deletedAt: null,
      deletedBy: null,
    };
    expect(AreaDtoSchema.parse(dto)).toEqual(dto);
  });

  it('parses problems with extension members and the config/health documents', () => {
    const problem = {
      type: 'urn:snapland:problem:rate-limited',
      title: 'Rate limited',
      status: 429,
      code: 'RATE_LIMITED',
      retryAfterMs: 8421,
      scope: 'draw',
    };
    expect(ProblemSchema.parse(problem)).toEqual(problem);
    expect(ProblemSchema.safeParse({ ...problem, code: 'NOPE' }).success).toBe(false);
    const ready = {
      status: 'degraded',
      instanceId: 'backend-1',
      version: '1.0.0',
      uptimeS: 3,
      checks: {
        database: { status: 'ok', latencyMs: 2 },
        redis: { status: 'fail', error: 'connect ECONNREFUSED' },
        migrations: { status: 'ok', pending: 0 },
        shutdown: { status: 'ok' },
        cacheRedis: { status: 'disabled' },
      },
    };
    expect(ReadyResponseSchema.parse(ready)).toEqual(ready);
    expect(ConfigResponseSchema.safeParse({}).success).toBe(false);
  });
});

describe('auth, client errors and admin schemas', () => {
  it('validates auth requests strictly', () => {
    expect(
      RegisterRequestSchema.safeParse({ username: 'alice', password: 'password1', displayName: 'Alice' })
        .success,
    ).toBe(true);
    expect(
      RegisterRequestSchema.safeParse({ username: 'al', password: 'password1', displayName: 'Alice' })
        .success,
    ).toBe(false);
    expect(
      RegisterRequestSchema.safeParse({ username: 'alice', password: 'short', displayName: 'Alice' }).success,
    ).toBe(false);
    expect(LoginRequestSchema.safeParse({ username: 'alice', password: 'x', admin: true }).success).toBe(
      false,
    );
    expect(
      WsTicketResponseSchema.safeParse({ ticket: 'a'.repeat(43), expiresAt: '2026-09-27T10:00:30.000Z' })
        .success,
    ).toBe(true);
  });

  it('bounds usernames at LIMITS.usernameMaxLength, the longest the pattern accepts (D-8)', () => {
    const email = (length: number): string => `${'a'.repeat(64)}@${'b'.repeat(length - 69)}.com`;
    const max = LIMITS.usernameMaxLength;
    expect(email(max)).toHaveLength(max);
    expect(UsernameSchema.safeParse(email(max)).success).toBe(true);
    expect(UsernameSchema.safeParse(email(max + 1)).success).toBe(false);
    expect(LoginRequestSchema.safeParse({ username: 'u'.repeat(max), password: 'x' }).success).toBe(true);
    expect(LoginRequestSchema.safeParse({ username: 'u'.repeat(max + 1), password: 'x' }).success).toBe(
      false,
    );
  });

  it('bounds client error reports', () => {
    const report = {
      kind: 'ws_close',
      code: 4400,
      message: 'closed',
      appVersion: '1.0.0',
      context: { attempt: 2 },
    };
    expect(ClientErrorReportSchema.safeParse(report).success).toBe(true);
    const manyKeys = Object.fromEntries(Array.from({ length: 21 }, (_, i) => [`k${i}`, i]));
    expect(ClientErrorReportSchema.safeParse({ ...report, context: manyKeys }).success).toBe(false);
    expect(ClientErrorReportSchema.safeParse({ ...report, kind: 'other' }).success).toBe(false);
  });

  it('validates admin audit queries', () => {
    expect(AuditLogQuerySchema.parse({ action: 'area.create', limit: '100' })).toEqual({
      action: 'area.create',
      limit: 100,
    });
    expect(AuditLogQuerySchema.safeParse({ action: 'DROP TABLE' }).success).toBe(false);
    expect(AuditStatsResponseSchema.safeParse({ from: 'x' }).success).toBe(false);
  });
});
