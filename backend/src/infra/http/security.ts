/**
 * CORS and security headers (SPEC section 10.7.2, section 10.7.6). CORS is an exact-origin allowlist with credentials (never `*`):
 * a disallowed origin receives no `Access-Control-*` header at all. Helmet sets `nosniff`, `no-referrer`,
 * same-origin CORP and a `default-src 'none'` CSP for JSON (swagger-ui sets its own CSP on /docs); HSTS is sent only
 * when the request arrived over HTTPS (as reported by the trusted proxy).
 */
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import type { FastifyInstance } from 'fastify';

const CORS_METHODS = ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS'];
const CORS_ALLOWED_HEADERS = ['Authorization', 'Content-Type', 'If-None-Match', 'X-Request-Id'];
/** Exported for the CORS integration test, which asserts the exact list. */
export const CORS_EXPOSED_HEADERS = [
  'ETag',
  'Location',
  'Retry-After',
  'X-Request-Id',
  'X-Cache',
  'Idempotent-Replay',
  'RateLimit-Limit',
  'RateLimit-Remaining',
  'RateLimit-Reset',
  'X-Draw-RateLimit-Limit',
  'X-Draw-RateLimit-Remaining',
  'X-Draw-RateLimit-Reset',
];
const CORS_MAX_AGE_S = 600;

const HSTS_VALUE = 'max-age=31536000; includeSubDomains';

export async function registerSecurity(
  app: FastifyInstance,
  allowedOrigins: readonly string[],
): Promise<void> {
  const allowlist = new Set(allowedOrigins);
  await app.register(cors, {
    // Requests without an Origin (same-origin navigations, curl) are not CORS requests: no headers either way.
    origin: (origin, callback) => {
      callback(null, origin !== undefined && allowlist.has(origin));
    },
    credentials: true,
    methods: CORS_METHODS,
    allowedHeaders: CORS_ALLOWED_HEADERS,
    exposedHeaders: CORS_EXPOSED_HEADERS,
    maxAge: CORS_MAX_AGE_S,
  });

  await app.register(helmet, {
    global: true,
    contentSecurityPolicy: {
      useDefaults: false,
      directives: { defaultSrc: ["'none'"], frameAncestors: ["'none'"] },
    },
    hsts: false,
    referrerPolicy: { policy: 'no-referrer' },
    crossOriginResourcePolicy: { policy: 'same-origin' },
  });

  app.addHook('onSend', (request, reply, payload, done) => {
    if (request.protocol === 'https') reply.header('Strict-Transport-Security', HSTS_VALUE);
    done(null, payload);
  });
}
