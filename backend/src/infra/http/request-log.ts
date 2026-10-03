/**
 * The request completion line and HTTP metrics (SPEC section 3.6, section 10.8). Reads are part of the analytics trail: the line
 * carries `method`, `route` (pattern, never the raw URL with its query string), `statusCode`, `responseTimeMs`,
 * `requestId` (the request logger binding), `userId` when authenticated, plus any `request.logContext` fields (e.g. bbox zoom/items/cache).
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

import type { Metrics } from '../metrics/metrics.js';

/** High-frequency probes are logged at debug to keep the trail readable. */
const QUIET_ROUTES = new Set(['/health/live', '/health/ready', '/metrics']);

function routeOf(request: FastifyRequest): string {
  return request.routeOptions.url ?? 'unmatched';
}

export function registerRequestLog(app: FastifyInstance, metrics: Metrics): void {
  const inFlight = new WeakSet<FastifyRequest>();

  const finish = (request: FastifyRequest): void => {
    if (!inFlight.delete(request)) return;
    metrics.httpRequestsInFlight.dec();
  };

  app.addHook('onRequest', (request, _reply, done) => {
    inFlight.add(request);
    metrics.httpRequestsInFlight.inc();
    done();
  });

  app.addHook('onResponse', (request: FastifyRequest, reply: FastifyReply, done) => {
    finish(request);
    const route = routeOf(request);
    const statusCode = reply.statusCode;
    metrics.httpRequestDuration.observe(
      { method: request.method, route, status_code: String(statusCode) },
      reply.elapsedTime / 1000,
    );
    const line = {
      method: request.method,
      route,
      statusCode,
      responseTimeMs: Math.round(reply.elapsedTime * 100) / 100,
      ...(request.auth === null ? {} : { userId: request.auth.userId }),
      ...request.logContext,
    };
    if (QUIET_ROUTES.has(route)) request.log.debug(line, 'request completed');
    else request.log.info(line, 'request completed');
    done();
  });

  app.addHook('onRequestAbort', (request, done) => {
    finish(request);
    request.log.info({ route: routeOf(request) }, 'request aborted by the client');
    done();
  });
}
