/**
 * Route safety net (SPEC section 10.7.3): a request without a response after REQUEST_TIMEOUT_MS gets 503 REQUEST_TIMEOUT.
 * It is attached per route (hook name `requestTimeoutSafetyNet`, visible in `printRoutes({ includeHooks: true })`) to
 * every route except WebSocket upgrades and `/metrics`. Node's own `requestTimeout` (408) covers slow request bodies.
 */
import type { FastifyInstance, FastifyRequest, onRequestHookHandler, RouteOptions } from 'fastify';

import { RequestTimeoutError } from './errors.js';
import { buildProblem, sendProblem } from './problem.js';

/** Paths that never get the safety net: long-lived upgrades and the metrics scrape. */
const EXEMPT_PATHS = new Set(['/ws', '/metrics']);

function isExempt(route: RouteOptions & { websocket?: boolean }): boolean {
  return route.websocket === true || EXEMPT_PATHS.has(route.url);
}

export function registerRequestTimeout(app: FastifyInstance, timeoutMs: number): void {
  const timers = new WeakMap<FastifyRequest, NodeJS.Timeout>();

  const requestTimeoutSafetyNet: onRequestHookHandler = function requestTimeoutSafetyNet(
    request,
    reply,
    done,
  ) {
    const timer = setTimeout(() => {
      timers.delete(request);
      if (reply.sent || reply.raw.headersSent) return;
      request.problemCode = 'REQUEST_TIMEOUT';
      request.log.warn({ timeoutMs }, 'request timed out; answering 503');
      sendProblem(reply, buildProblem(new RequestTimeoutError(), request));
    }, timeoutMs);
    timer.unref();
    timers.set(request, timer);
    done();
  };

  const clear = (request: FastifyRequest): void => {
    const timer = timers.get(request);
    if (timer !== undefined) {
      clearTimeout(timer);
      timers.delete(request);
    }
  };

  app.addHook('onRoute', (route) => {
    if (isExempt(route)) return;
    // First in the route's onRequest chain, so slow authentication counts toward the deadline too.
    const existing =
      route.onRequest === undefined
        ? []
        : Array.isArray(route.onRequest)
          ? route.onRequest
          : [route.onRequest];
    route.onRequest = [requestTimeoutSafetyNet, ...existing];
  });
  app.addHook('onResponse', (request, _reply, done) => {
    clear(request);
    done();
  });
  app.addHook('onRequestAbort', (request, done) => {
    clear(request);
    done();
  });
}
