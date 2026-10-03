import type { FastifyRequest } from 'fastify';
import { ResponseSerializationError } from 'fastify-type-provider-zod';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import {
  AppError,
  BadRequestError,
  ConflictError,
  DependencyUnavailableError,
  ForbiddenError,
  InvalidGeometryError,
  NotFoundError,
  PreconditionRequiredError,
  RateLimitedError,
  RequestTimeoutError,
  ServiceUnavailableError,
  UnauthorizedError,
  ValidationError,
} from './errors.js';
import { buildProblem, toAppError } from './problem.js';

const request = {
  id: 'req-1',
  url: '/api/v1/areas?bbox=1',
  raw: { url: '/api/v1/areas?bbox=1' },
} as unknown as FastifyRequest;

function errorWith(fields: Record<string, unknown>, message = 'driver failure'): Error {
  return Object.assign(new Error(message), fields);
}

describe('toAppError mapping table (section 3.5)', () => {
  it.each([
    [
      'a Fastify/zod validation error',
      errorWith({
        code: 'FST_ERR_VALIDATION',
        validation: [{ instancePath: '/name', keyword: 'too_big', message: 'Too big' }],
        validationContext: 'body',
      }),
      'VALIDATION_FAILED',
      400,
    ],
    [
      'a body over the limit',
      errorWith({ code: 'FST_ERR_CTP_BODY_TOO_LARGE', statusCode: 413 }),
      'PAYLOAD_TOO_LARGE',
      413,
    ],
    [
      'a non-JSON media type',
      errorWith({ code: 'FST_ERR_CTP_INVALID_MEDIA_TYPE', statusCode: 415 }),
      'UNSUPPORTED_MEDIA_TYPE',
      415,
    ],
    [
      'malformed JSON',
      errorWith({ code: 'FST_ERR_CTP_INVALID_JSON_BODY', statusCode: 400 }),
      'VALIDATION_FAILED',
      400,
    ],
    ['a JSON SyntaxError', new SyntaxError('Unexpected end of JSON input'), 'VALIDATION_FAILED', 400],
    ['pg 57014 (statement timeout)', errorWith({ code: '57014' }), 'REQUEST_TIMEOUT', 503],
    ['a client-side query read timeout', new Error('Query read timeout'), 'REQUEST_TIMEOUT', 503],
    [
      'pg 23514 on areas_geom_valid_ck',
      errorWith({ code: '23514', constraint: 'areas_geom_valid_ck' }),
      'INVALID_GEOMETRY',
      422,
    ],
    [
      'pg 23514 on another CHECK',
      errorWith({ code: '23514', constraint: 'areas_name_len_ck' }),
      'INTERNAL_ERROR',
      500,
    ],
    ['pg connection failure (08006)', errorWith({ code: '08006' }), 'DEPENDENCY_UNAVAILABLE', 503],
    ['ECONNREFUSED', errorWith({ code: 'ECONNREFUSED' }), 'DEPENDENCY_UNAVAILABLE', 503],
    [
      'an exhausted pool',
      new Error('timeout exceeded when trying to connect'),
      'DEPENDENCY_UNAVAILABLE',
      503,
    ],
    ['a Redis command timeout', new Error('Command timed out'), 'DEPENDENCY_UNAVAILABLE', 503],
    [
      'a Redis offline-queue refusal',
      new Error("Stream isn't writeable and enableOfflineQueue options is false"),
      'DEPENDENCY_UNAVAILABLE',
      503,
    ],
    [
      'MaxRetriesPerRequestError',
      Object.assign(new Error('max retries'), { name: 'MaxRetriesPerRequestError' }),
      'DEPENDENCY_UNAVAILABLE',
      503,
    ],
    ['a Fastify 404', errorWith({ code: 'FST_ERR_NOT_FOUND', statusCode: 404 }), 'NOT_FOUND', 404],
    [
      'another Fastify 4xx',
      errorWith({ code: 'FST_ERR_CTP_INVALID_CONTENT_LENGTH', statusCode: 400 }),
      'VALIDATION_FAILED',
      400,
    ],
    ['an unknown error', new Error('boom'), 'INTERNAL_ERROR', 500],
    ['a thrown string', 'boom', 'INTERNAL_ERROR', 500],
  ])('maps %s', (_label, error, code, status) => {
    const appError = toAppError(error);
    expect(appError.code).toBe(code);
    expect(appError.status).toBe(status);
  });

  it('keeps AppErrors and maps response serialization failures to 500', () => {
    const conflict = new ConflictError('AREA_ID_CONFLICT', 'taken');
    expect(toAppError(conflict)).toBe(conflict);
    const zodError = z.string().safeParse(1).error;
    if (zodError === undefined) throw new Error('expected a zod error');
    expect(toAppError(new ResponseSerializationError('GET', '/x', { cause: zodError })).code).toBe(
      'INTERNAL_ERROR',
    );
  });

  it('turns validation issues into errors[] with request-part paths', () => {
    const appError = toAppError(
      errorWith({
        code: 'FST_ERR_VALIDATION',
        validation: [
          { instancePath: '/geometry/coordinates/0', keyword: 'invalid_type', message: undefined },
        ],
        validationContext: 'body',
      }),
    );
    expect(appError.extensions['errors']).toEqual([
      { path: 'body.geometry.coordinates.0', code: 'invalid_type', message: 'is invalid' },
    ]);
  });
});

describe('buildProblem', () => {
  it('builds an RFC 9457 document with the request id, the path without its query and the extensions', () => {
    const problem = buildProblem(
      new ConflictError('VERSION_CONFLICT', 'Fields changed.', { currentVersion: 4 }),
      request,
    );
    expect(problem).toEqual({
      status: 409,
      headers: {},
      body: {
        type: 'urn:snapland:problem:version-conflict',
        title: 'Version conflict',
        status: 409,
        code: 'VERSION_CONFLICT',
        detail: 'Fields changed.',
        instance: '/api/v1/areas',
        requestId: 'req-1',
        currentVersion: 4,
      },
    });
  });

  it('replaces every 5xx detail with a generic reference (no internals)', () => {
    const problem = buildProblem(new AppError('INTERNAL_ERROR', 'password=hunter2 at pg.js:10'), request);
    expect(problem.body['detail']).toBe('An unexpected error occurred. Reference: req-1');
    expect(JSON.stringify(problem)).not.toContain('hunter2');
  });

  it('carries Retry-After headers of rate limits and unavailable dependencies', () => {
    expect(
      buildProblem(new RateLimitedError({ scope: 'draw', limit: 50, retryAfterMs: 8421 }), request),
    ).toMatchObject({
      status: 429,
      headers: { 'Retry-After': '9' },
      body: { code: 'RATE_LIMITED', scope: 'draw', limit: 50, retryAfterMs: 8421 },
    });
    expect(buildProblem(new DependencyUnavailableError(), request).headers).toEqual({ 'Retry-After': '5' });
    expect(buildProblem(new ServiceUnavailableError('draining', 59.2), request).headers).toEqual({
      'Retry-After': '60',
    });
    expect(buildProblem(new ServiceUnavailableError(), request).headers).toEqual({});
  });
});

describe('typed errors', () => {
  it('derive their status from the shared catalog', () => {
    expect(new ValidationError('bad').status).toBe(400);
    expect(new BadRequestError('INVALID_BBOX', 'bad bbox').status).toBe(400);
    expect(new UnauthorizedError('TOKEN_EXPIRED').status).toBe(401);
    expect(new ForbiddenError().code).toBe('FORBIDDEN');
    expect(new NotFoundError().code).toBe('NOT_FOUND');
    expect(new PreconditionRequiredError().status).toBe(428);
    expect(new RequestTimeoutError().status).toBe(503);
    expect(
      new InvalidGeometryError([
        { code: 'SELF_INTERSECTION', message: 'Ring 0 self-intersects.', path: 'geometry.coordinates.0' },
      ]).detail,
    ).toBe('Ring 0 self-intersects.');
    expect(new InvalidGeometryError([]).detail).toBe('The geometry is invalid.');
    expect(new RateLimitedError({ scope: 'api', limit: 1, retryAfterMs: -5 }).retryAfterMs).toBe(0);
    expect(new DependencyUnavailableError('x', new Error('cause')).cause).toBeInstanceOf(Error);
  });
});
