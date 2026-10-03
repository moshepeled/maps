import type { FastifyRequest } from 'fastify';
import type { IncomingMessage } from 'node:http';
import { describe, expect, it } from 'vitest';

import { buildActorContext, generateRequestId, normalizeIp, normalizeUserAgent } from './request-context.js';

describe('request context (section 3.2, section 10.7.1)', () => {
  it('keeps a valid inbound x-request-id and replaces anything else with a UUID', () => {
    const raw = (id: unknown) => ({ headers: { 'x-request-id': id } }) as unknown as IncomingMessage;
    expect(generateRequestId(raw('abc-123_X.y'))).toBe('abc-123_X.y');
    expect(generateRequestId(raw('has spaces'))).toMatch(/^[0-9a-f-]{36}$/);
    expect(generateRequestId(raw('x'.repeat(65)))).toMatch(/^[0-9a-f-]{36}$/);
    expect(generateRequestId(raw(['a', 'b']))).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('truncates a 600-character User-Agent to 512 code points and never rejects it', () => {
    expect(normalizeUserAgent('M'.repeat(600))).toHaveLength(512);
    expect(normalizeUserAgent(`Mozilla${String.fromCharCode(0)}/5.0`)).toBe('Mozilla/5.0');
    expect(normalizeUserAgent(['a', 'b'])).toBe('a b');
    expect(normalizeUserAgent('   ')).toBeNull();
    expect(normalizeUserAgent(undefined)).toBeNull();
  });

  it('keeps only syntactically valid IPs', () => {
    expect(normalizeIp('10.1.2.3')).toBe('10.1.2.3');
    expect(normalizeIp('::1')).toBe('::1');
    expect(normalizeIp('not-an-ip')).toBeNull();
    expect(normalizeIp(undefined)).toBeNull();
  });

  it('builds the ActorContext services receive', () => {
    const authenticated = {
      id: 'req-9',
      ip: '10.0.0.1',
      headers: { 'user-agent': 'vitest' },
      auth: { userId: 'u1', sessionId: 's1', username: 'alice', displayName: 'Alice', role: 'admin' },
    } as unknown as FastifyRequest;
    expect(buildActorContext(authenticated)).toEqual({
      userId: 'u1',
      sessionId: 's1',
      role: 'admin',
      requestId: 'req-9',
      ip: '10.0.0.1',
      userAgent: 'vitest',
    });
    const anonymous = { id: 'req-10', ip: 'garbage', headers: {}, auth: null } as unknown as FastifyRequest;
    expect(buildActorContext(anonymous)).toEqual({
      userId: null,
      sessionId: null,
      role: null,
      requestId: 'req-10',
      ip: null,
      userAgent: null,
    });
  });
});
