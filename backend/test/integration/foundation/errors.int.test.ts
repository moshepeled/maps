import { ProblemSchema } from '@snapland/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';

import { ConflictError, DependencyUnavailableError } from '../../../src/infra/http/errors.js';
import { createTestApp } from '../../helpers/test-app.js';
import type { TestApp } from '../../helpers/test-app.js';

let testApp: TestApp;

beforeAll(async () => {
  testApp = await createTestApp({
    config: { BODY_LIMIT_BYTES: 1024 },
    routes: (app) => {
      app.post(
        '/echo',
        {
          schema: {
            body: z.strictObject({ name: z.string().max(5), count: z.number().int() }),
            querystring: z.strictObject({ q: z.string().optional() }),
          },
        },
        (request) => request.body,
      );
      app.get('/conflict', () => {
        throw new ConflictError('VERSION_CONFLICT', 'Fields [geometry] changed.', {
          baseVersion: 3,
          currentVersion: 4,
        });
      });
      app.get('/boom', () => {
        throw new Error('db password=hunter2 host=10.1.2.3 exploded');
      });
      app.get('/unavailable', () => {
        throw new DependencyUnavailableError('pool exhausted');
      });
    },
  });
});

afterAll(async () => {
  await testApp.close();
});

function problemOf(body: string) {
  return ProblemSchema.parse(JSON.parse(body));
}

describe('problem+json error model (section 3.5)', () => {
  it('answers unknown routes with 404 NOT_FOUND, the request id and the path without its query string', async () => {
    const response = await testApp.app.inject({
      method: 'GET',
      url: '/nope?token=secret',
      headers: { 'x-request-id': 'req-123' },
    });
    expect(response.statusCode).toBe(404);
    expect(response.headers['content-type']).toContain('application/problem+json');
    expect(response.headers['x-request-id']).toBe('req-123');
    expect(problemOf(response.body)).toMatchObject({
      type: 'urn:snapland:problem:not-found',
      title: 'Not found',
      status: 404,
      code: 'NOT_FOUND',
      instance: '/nope',
      requestId: 'req-123',
    });
  });

  it('maps transport (zod) failures to 400 VALIDATION_FAILED with errors[] paths - never another status', async () => {
    const response = await testApp.app.inject({
      method: 'POST',
      url: '/__test/echo',
      payload: { name: 'toolong', count: 1.5, extra: true },
    });
    expect(response.statusCode).toBe(400);
    const problem = problemOf(response.body);
    expect(problem.code).toBe('VALIDATION_FAILED');
    expect(problem.errors?.length).toBeGreaterThan(0);
    expect(problem.errors?.every((error) => error.path.startsWith('body'))).toBe(true);
    const query = await testApp.app.inject({
      method: 'POST',
      url: '/__test/echo?bogus=1',
      payload: { name: 'a', count: 1 },
    });
    expect(problemOf(query.body)).toMatchObject({ status: 400, code: 'VALIDATION_FAILED' });
  });

  it('answers malformed JSON with 400, a large body with 413 and a non-JSON body with 415', async () => {
    const malformed = await testApp.app.inject({
      method: 'POST',
      url: '/__test/echo',
      headers: { 'content-type': 'application/json' },
      payload: '{"name": ',
    });
    expect(problemOf(malformed.body)).toMatchObject({ status: 400, code: 'VALIDATION_FAILED' });
    const large = await testApp.app.inject({
      method: 'POST',
      url: '/__test/echo',
      payload: { name: 'x'.repeat(2000), count: 1 },
    });
    expect(problemOf(large.body)).toMatchObject({ status: 413, code: 'PAYLOAD_TOO_LARGE' });
    const text = await testApp.app.inject({
      method: 'POST',
      url: '/__test/echo',
      headers: { 'content-type': 'text/plain' },
      payload: 'hi',
    });
    expect(problemOf(text.body)).toMatchObject({ status: 415, code: 'UNSUPPORTED_MEDIA_TYPE' });
  });

  it('keeps extension members of typed errors', async () => {
    const response = await testApp.app.inject({ method: 'GET', url: '/__test/conflict' });
    expect(response.statusCode).toBe(409);
    expect(problemOf(response.body)).toMatchObject({
      code: 'VERSION_CONFLICT',
      baseVersion: 3,
      currentVersion: 4,
      detail: 'Fields [geometry] changed.',
    });
  });

  it('logs a 5xx at error with err while the body stays generic (no internals)', async () => {
    testApp.logs.clear();
    const response = await testApp.app.inject({ method: 'GET', url: '/__test/boom' });
    expect(response.statusCode).toBe(500);
    const problem = problemOf(response.body);
    expect(problem.code).toBe('INTERNAL_ERROR');
    expect(problem.detail).toBe(`An unexpected error occurred. Reference: ${problem.requestId ?? ''}`);
    expect(response.body).not.toMatch(/hunter2|10\.1\.2\.3|stack|at /);
    const logged = testApp.logs.find((line) => line.level === 'error' && line.msg === 'request failed');
    expect(logged).toHaveLength(1);
    expect(JSON.stringify(logged[0]?.['err'])).toContain('exploded');
  });

  it('sends Retry-After: 5 with DEPENDENCY_UNAVAILABLE', async () => {
    const response = await testApp.app.inject({ method: 'GET', url: '/__test/unavailable' });
    expect(response.statusCode).toBe(503);
    expect(response.headers['retry-after']).toBe('5');
    expect(problemOf(response.body).code).toBe('DEPENDENCY_UNAVAILABLE');
  });

  it('replaces an invalid inbound x-request-id and logs the completion line with route pattern and status', async () => {
    testApp.logs.clear();
    const response = await testApp.app.inject({
      method: 'GET',
      url: '/api/v1/config?x=1',
      headers: { 'x-request-id': 'bad id with spaces' },
    });
    const requestId = response.headers['x-request-id'];
    expect(requestId).toMatch(/^[0-9a-f-]{36}$/);
    const [line] = testApp.logs.find((entry) => entry.msg === 'request completed');
    expect(line).toMatchObject({ method: 'GET', route: '/api/v1/config', statusCode: 200, requestId });
    expect(JSON.stringify(line)).not.toContain('x=1');
  });
});
