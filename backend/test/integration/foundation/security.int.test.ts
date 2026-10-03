import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { CORS_EXPOSED_HEADERS } from '../../../src/infra/http/security.js';
import { createTestApp } from '../../helpers/test-app.js';
import type { TestApp } from '../../helpers/test-app.js';

const ALLOWED = 'http://localhost:5173';
const DISALLOWED = 'https://evil.example';

let testApp: TestApp;

beforeAll(async () => {
  testApp = await createTestApp();
});

afterAll(async () => {
  await testApp.close();
});

function corsHeaders(headers: Record<string, unknown>): string[] {
  return Object.keys(headers).filter((name) => name.toLowerCase().startsWith('access-control-'));
}

describe('CORS (section 10.7.2)', () => {
  it('answers an allowed preflight for PATCH /api/v1/areas/{id} with the exact headers', async () => {
    const response = await testApp.app.inject({
      method: 'OPTIONS',
      url: '/api/v1/areas/7d7a4c52-9a0b-4e0f-b3c1-2e5f6a7b8c9d',
      headers: {
        origin: ALLOWED,
        'access-control-request-method': 'PATCH',
        'access-control-request-headers': 'authorization, content-type, if-none-match',
      },
    });
    expect(response.statusCode).toBe(204);
    expect(response.headers['access-control-allow-origin']).toBe(ALLOWED);
    expect(response.headers['access-control-allow-credentials']).toBe('true');
    expect(response.headers['access-control-max-age']).toBe('600');
    const methods = String(response.headers['access-control-allow-methods'])
      .split(',')
      .map((m) => m.trim());
    expect(methods).toEqual(expect.arrayContaining(['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS']));
    const allowed = String(response.headers['access-control-allow-headers']).toLowerCase();
    for (const header of ['authorization', 'content-type', 'if-none-match', 'x-request-id'])
      expect(allowed).toContain(header);
  });

  it('exposes exactly the documented headers on a simple GET from an allowed origin', async () => {
    const response = await testApp.app.inject({
      method: 'GET',
      url: '/api/v1/config',
      headers: { origin: ALLOWED },
    });
    expect(response.headers['access-control-allow-origin']).toBe(ALLOWED);
    const exposed = String(response.headers['access-control-expose-headers'])
      .split(',')
      .map((h) => h.trim());
    expect(exposed).toEqual([...CORS_EXPOSED_HEADERS]);
  });

  it('sends no Access-Control-* header at all to a disallowed origin (preflight and simple request)', async () => {
    const preflight = await testApp.app.inject({
      method: 'OPTIONS',
      url: '/api/v1/areas/7d7a4c52-9a0b-4e0f-b3c1-2e5f6a7b8c9d',
      headers: { origin: DISALLOWED, 'access-control-request-method': 'PATCH' },
    });
    expect(corsHeaders(preflight.headers)).toEqual([]);
    const simple = await testApp.app.inject({
      method: 'GET',
      url: '/api/v1/config',
      headers: { origin: DISALLOWED },
    });
    expect(simple.statusCode).toBe(200);
    expect(corsHeaders(simple.headers)).toEqual([]);
  });
});

describe('security headers (section 10.7.6)', () => {
  function expectHelmet(headers: Record<string, unknown>): void {
    expect(headers['content-security-policy']).toBe("default-src 'none';frame-ancestors 'none'");
    expect(headers['x-content-type-options']).toBe('nosniff');
    expect(headers['referrer-policy']).toBe('no-referrer');
    expect(headers['cross-origin-resource-policy']).toBe('same-origin');
    expect(headers['x-powered-by']).toBeUndefined();
    expect(headers['strict-transport-security']).toBeUndefined();
  }

  it('sets them on a JSON route', async () => {
    expectHelmet((await testApp.app.inject({ method: 'GET', url: '/api/v1/config' })).headers);
  });

  it('sets them on an error response (404 problem+json)', async () => {
    const response = await testApp.app.inject({ method: 'GET', url: '/does-not-exist' });
    expect(response.statusCode).toBe(404);
    expectHelmet(response.headers);
  });

  it('adds HSTS only when the trusted proxy reports HTTPS', async () => {
    const response = await testApp.app.inject({
      method: 'GET',
      url: '/api/v1/config',
      headers: { 'x-forwarded-proto': 'https' },
      remoteAddress: '127.0.0.1',
    });
    expect(response.headers['strict-transport-security']).toBe('max-age=31536000; includeSubDomains');
  });
});
