/**
 * Request identity and the boundary normalisation of request metadata (SPEC section 3.2, section 3.6, section 10.7.1): request ids (a valid
 * inbound `x-request-id` or a fresh UUID, echoed on every response), and the `ActorContext` services receive instead of
 * the Fastify request - with the User-Agent sanitised and cut to 512 code points and the IP validated, so an
 * over-long header can neither fail a login (sessions CHECK) nor poison an audit batch.
 */
import { randomUUID } from 'node:crypto';
import { isIP } from 'node:net';

import { LIMITS, sanitizeText } from '@snapland/shared';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { IncomingMessage } from 'node:http';

export interface ActorContext {
  userId: string | null;
  sessionId: string | null;
  role: 'user' | 'admin' | null;
  requestId: string;
  ip: string | null;
  userAgent: string | null;
}

const REQUEST_ID_HEADER = 'x-request-id';
const USER_AGENT_MAX_CODE_POINTS = 512;

const REQUEST_ID_PATTERN = new RegExp(LIMITS.requestIdPattern);

/** Fastify `genReqId`: a valid inbound id is kept for correlation, anything else is replaced. */
export function generateRequestId(raw: IncomingMessage): string {
  const inbound = raw.headers[REQUEST_ID_HEADER];
  return typeof inbound === 'string' && REQUEST_ID_PATTERN.test(inbound) ? inbound : randomUUID();
}

/** Sanitised, truncated User-Agent (never rejected); null when absent or empty. */
export function normalizeUserAgent(header: string | string[] | undefined): string | null {
  const value = Array.isArray(header) ? header.join(' ') : header;
  if (value === undefined) return null;
  const result = sanitizeText(value, {
    maxLength: USER_AGENT_MAX_CODE_POINTS,
    truncate: true,
    allowEmpty: true,
  });
  return result.ok && result.value !== '' ? result.value : null;
}

/** The IP if it is a syntactically valid IPv4/IPv6 address, else null (it is stored in an `inet` column). */
export function normalizeIp(ip: string | undefined): string | null {
  return ip !== undefined && isIP(ip) !== 0 ? ip : null;
}

export function buildActorContext(request: FastifyRequest): ActorContext {
  return {
    userId: request.auth?.userId ?? null,
    sessionId: request.auth?.sessionId ?? null,
    role: request.auth?.role ?? null,
    requestId: request.id,
    ip: normalizeIp(request.ip),
    userAgent: normalizeUserAgent(request.headers['user-agent']),
  };
}

/** Request decorations and the `x-request-id` echo. */
export function registerRequestContext(app: FastifyInstance): void {
  app.decorateRequest('auth', null);
  app.decorateRequest('problemCode', null);
  app.decorateRequest('authFailed', false);
  // Declared null and created per request: a shared default object would leak fields between requests.
  app.decorateRequest('logContext', null, []);
  app.decorateRequest('actor', function actor(this: FastifyRequest) {
    return buildActorContext(this);
  });
  app.addHook('onRequest', (request, reply, done) => {
    request.logContext = {};
    reply.header(REQUEST_ID_HEADER, request.id);
    done();
  });
}
