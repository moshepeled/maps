import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { run as exportOpenApi } from '../../../src/scripts/export-openapi.js';
import { createTestApp, testConfig } from '../../helpers/test-app.js';
import type { TestApp } from '../../helpers/test-app.js';

let testApp: TestApp;

interface Operation {
  summary?: string;
  responses?: Record<string, { content?: Record<string, { schema?: Record<string, unknown> }> }>;
}

interface OpenApiDocument {
  openapi: string;
  info: { title: string; version: string };
  paths: Record<string, Record<string, Operation>>;
}

beforeAll(async () => {
  testApp = await createTestApp();
});

afterAll(async () => {
  await testApp.close();
});

/** Error statuses every /api/v1 route documents (section 6.1: "besides 400 VALIDATION_FAILED, 429, 500, 503"). */
const GLOBAL_ERRORS = ['400', '429', '500', '503'];
/** Route-specific statuses of section 6.1. */
const EXPECTED_ERRORS: Record<string, string[]> = {
  'post /api/v1/client-errors': ['401'],
  'post /api/v1/auth/register': ['409'],
  'post /api/v1/auth/login': ['401', '403'],
  'post /api/v1/auth/refresh': ['401'],
  'post /api/v1/auth/logout': ['401'],
  'get /api/v1/auth/me': ['401'],
  'get /api/v1/auth/sessions': ['401'],
  'delete /api/v1/auth/sessions/{sessionId}': ['401', '404'],
  'post /api/v1/auth/ws-ticket': ['401'],
};
const HTTP_METHODS = new Set(['get', 'post', 'put', 'patch', 'delete']);

function operations(document: OpenApiDocument): [string, Operation][] {
  return Object.entries(document.paths).flatMap(([path, item]) =>
    Object.entries(item)
      .filter(([method]) => HTTP_METHODS.has(method))
      .map(([method, operation]): [string, Operation] => [`${method} ${path}`, operation]),
  );
}

function isProblemSchema(schema: Record<string, unknown> | undefined): boolean {
  const properties = schema?.['properties'] as Record<string, unknown> | undefined;
  return properties !== undefined && ['type', 'title', 'status', 'code'].every((name) => name in properties);
}

describe('OpenAPI 3.1 document (section 6, S6)', () => {
  it('is served at /docs/json with every route documented', async () => {
    const response = await testApp.app.inject({ method: 'GET', url: '/docs/json' });
    expect(response.statusCode).toBe(200);
    const document = response.json<OpenApiDocument>();
    expect(document.openapi).toBe('3.1.0');
    expect(document.info).toMatchObject({ title: 'Snapland API', version: '1.0.0' });
    const ops = operations(document);
    expect(ops.map(([key]) => key)).toEqual(
      expect.arrayContaining([
        'get /health/live',
        'get /health/ready',
        'get /api/v1/config',
        'post /api/v1/client-errors',
      ]),
    );

    for (const [key, operation] of ops) {
      expect(operation.summary, `${key} summary`).toBeTruthy();
      const responses = operation.responses ?? {};
      const success = Object.keys(responses).find((status) => status.startsWith('2'));
      expect(success, `${key} success response`).toBeDefined();
      if (!key.includes('/api/v1/')) continue;
      for (const status of [...GLOBAL_ERRORS, ...(EXPECTED_ERRORS[key] ?? [])]) {
        const schema = responses[status]?.content?.['application/json']?.schema;
        expect(isProblemSchema(schema), `${key} ${status} problem schema`).toBe(true);
      }
    }
  });

  it('is exported by the export-openapi script (--stdout prints JSON only)', async () => {
    let stdout = '';
    const code = await exportOpenApi(['--stdout'], {
      stdout: { write: (chunk: string) => (stdout += chunk) },
      loadConfig: () => testConfig(),
    });
    expect(code).toBe(0);
    const document = JSON.parse(stdout) as OpenApiDocument;
    expect(document.paths['/api/v1/config']).toBeDefined();
  });
});
