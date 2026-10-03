/**
 * `buildApp(container)` (SPEC section 3.1, section 3.3): the Fastify instance with every cross-cutting plugin and decoration
 * (`app.authenticate`, `app.requireRole`, `app.drawRateLimit`, `request.actor()`, `request.logContext`), then every
 * feature module registered in a fixed order. It touches no process-global state, so several apps may share a process.
 */
import cookie from '@fastify/cookie';
import swagger from '@fastify/swagger';
import swaggerUi from '@fastify/swagger-ui';
import websocket from '@fastify/websocket';
import { REALTIME } from '@snapland/shared';
import Fastify, { LogController } from 'fastify';
import type { FastifyBaseLogger, FastifyInstance } from 'fastify';
import { jsonSchemaTransform, serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';

import { APP_VERSION } from './config/version.js';
import type { Container } from './container.js';
import { createAuthenticate } from './infra/auth/authenticate.js';
import { registerAuditHook } from './infra/http/audit-hook.js';
import { createDrawRateLimit } from './infra/http/draw-rate-limit.js';
import { registerProblemHandlers } from './infra/http/problem.js';
import { registerRateLimiting } from './infra/http/rate-limits.js';
import { generateRequestId, registerRequestContext } from './infra/http/request-context.js';
import { registerRequestLog } from './infra/http/request-log.js';
import { registerRequestTimeout } from './infra/http/request-timeout.js';
import { createRequireRole } from './infra/http/require-role.js';
import { registerSecurity } from './infra/http/security.js';
import { toFastifyTrustProxy } from './infra/http/trust-proxy.js';
import type { AppInstance, LifecycleState } from './infra/http/types.js';
import { createAdminModule } from './modules/admin/index.js';
import { createAreasModule } from './modules/areas/index.js';
import { createAuthModule } from './modules/auth/index.js';
import { createHealthModule } from './modules/health/index.js';
import { createMetaModule } from './modules/meta/index.js';
import { createRealtimeModule } from './modules/realtime/index.js';
import { createRetentionModule } from './modules/retention/index.js';
import type { ModuleFactory } from './modules/types.js';

/** Every feature module, in registration order (stopped in reverse order, section 10.12). */
export const APP_MODULES: readonly ModuleFactory[] = [
  createHealthModule,
  createMetaModule,
  createAuthModule,
  createAreasModule,
  createRealtimeModule,
  createAdminModule,
  createRetentionModule,
];

/** keepAliveTimeout must exceed nginx's upstream keepalive (60 s); idle sockets close after 30 s (section 10.7.3). */
const KEEP_ALIVE_TIMEOUT_MS = 65_000;
const CONNECTION_TIMEOUT_MS = 30_000;
const TEST_ROUTE_PREFIX = '/__test';

export interface BuildAppOptions {
  /** Module factories (default: APP_MODULES). */
  modules?: readonly ModuleFactory[];
  /** Test-only routes, registered under `/__test` with every app decoration available (createTestApp). */
  testRoutes?: (app: AppInstance, container: Container) => void | Promise<void>;
}

export interface SnaplandApp {
  readonly app: AppInstance;
  /** Starts every module's background work in registration order (call after listen). */
  start(): Promise<void>;
  /** Stops every module's background work in reverse order; failures are logged, never thrown. */
  stop(): Promise<void>;
}

function createFastify(container: Container): AppInstance {
  const { config } = container;
  // Node checks request timeouts on this interval (default 30 s): keep it well below HTTP_REQUEST_TIMEOUT_MS.
  const connectionsCheckingInterval = Math.max(
    100,
    Math.min(1000, Math.floor(config.HTTP_REQUEST_TIMEOUT_MS / 4)),
  );
  // Typed as the base logger so every scope (plugins, test routes) shares one AppInstance type.
  const loggerInstance: FastifyBaseLogger = container.logger;
  return Fastify({
    loggerInstance,
    // Our own completion line (request-log.ts) replaces Fastify's; the id binding is named like the header value.
    logController: new LogController({ disableRequestLogging: true, requestIdLogLabel: 'requestId' }),
    genReqId: generateRequestId,
    trustProxy: toFastifyTrustProxy(config.TRUST_PROXY),
    bodyLimit: config.BODY_LIMIT_BYTES,
    requestTimeout: config.HTTP_REQUEST_TIMEOUT_MS,
    keepAliveTimeout: KEEP_ALIVE_TIMEOUT_MS,
    connectionTimeout: CONNECTION_TIMEOUT_MS,
    // Node only enforces requestTimeout when it is given to the server constructor (setting it later is ignored).
    http: { requestTimeout: config.HTTP_REQUEST_TIMEOUT_MS, connectionsCheckingInterval },
  }).withTypeProvider<ZodTypeProvider>();
}

async function registerDocs(app: FastifyInstance, docsEnabled: boolean): Promise<void> {
  await app.register(swagger, {
    openapi: {
      openapi: '3.1.0',
      info: {
        title: 'Snapland API',
        version: APP_VERSION,
        description:
          'Collaborative GIS: areas, versions, change feed, sessions. Realtime events use the snapland.v1 WebSocket protocol.',
      },
      components: {
        securitySchemes: {
          bearerAuth: { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' },
          // The rotating refresh token (section 6.2): HttpOnly cookie, sent only to /api/v1/auth (refresh, logout).
          refreshCookie: { type: 'apiKey', in: 'cookie', name: 'snap_rt' },
        },
      },
    },
    transform: jsonSchemaTransform,
  });
  if (docsEnabled) await app.register(swaggerUi, { routePrefix: '/docs', staticCSP: true });
}

async function registerWebSocket(app: FastifyInstance, container: Container): Promise<void> {
  await app.register(websocket, {
    options: {
      maxPayload: container.config.WS_MAX_PAYLOAD_BYTES,
      perMessageDeflate: container.config.WS_PERMESSAGE_DEFLATE,
      // Select snapland.v1 when offered; the realtime route rejects upgrades without it (400) before upgrading.
      handleProtocols: (protocols: Set<string>) =>
        protocols.has(REALTIME.subprotocol) ? REALTIME.subprotocol : false,
    },
    // section 10.12 step 2: every socket is closed with 1001 "going away" so clients reconnect to another instance.
    preClose(this: FastifyInstance, done: () => void) {
      for (const client of this.websocketServer.clients) client.close(1001, 'server shutting down');
      done();
    },
  });
}

function decorate(
  app: AppInstance,
  container: Container,
  authenticate: ReturnType<typeof createAuthenticate>,
): void {
  const lifecycleState: LifecycleState = { shuttingDown: false };
  app.decorate('lifecycleState', lifecycleState);
  app.decorate('authenticate', authenticate);
  app.decorate('requireRole', createRequireRole(container.users));
  app.decorate(
    'drawRateLimit',
    createDrawRateLimit({
      limiter: container.drawRateLimiter,
      metrics: container.metrics,
      auditCoalescer: container.auditCoalescer,
      clock: container.clock,
      windowMs: container.config.DRAW_RATE_LIMIT_WINDOW_MS,
    }),
  );
}

export async function buildApp(container: Container, options: BuildAppOptions = {}): Promise<SnaplandApp> {
  const app = createFastify(container);
  // JSON only (section 6): without Fastify's default text/plain parser, any other media type is a 415.
  app.removeContentTypeParser('text/plain');
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);

  const authenticate = createAuthenticate({
    accessTokens: container.accessTokens,
    revocations: container.revocations,
  });
  registerRequestContext(app);
  registerRequestLog(app, container.metrics);
  registerProblemHandlers(app);
  decorate(app, container, authenticate);

  await registerSecurity(app, container.config.CORS_ORIGINS);
  await app.register(cookie);
  registerRequestTimeout(app, container.config.REQUEST_TIMEOUT_MS);
  await registerRateLimiting(app, {
    config: container.config,
    redis: container.redis.cmd,
    keys: container.keys,
    metrics: container.metrics,
    auditCoalescer: container.auditCoalescer,
    authenticate,
  });
  registerAuditHook(app, { audit: container.audit, tracker: container.auditTracker });
  await registerDocs(app, container.config.DOCS_ENABLED);
  await registerWebSocket(app, container);

  const modules = (options.modules ?? APP_MODULES).map((factory) => factory(container));
  for (const module of modules) await module.register(app);

  const testRoutes = options.testRoutes;
  if (testRoutes !== undefined) {
    await app.register(
      async (scope) => {
        await testRoutes(scope.withTypeProvider<ZodTypeProvider>(), container);
      },
      { prefix: TEST_ROUTE_PREFIX },
    );
  }

  const log = container.logger.child({ component: 'app' });
  return {
    app,
    async start() {
      for (const module of modules) await module.start?.();
    },
    async stop() {
      for (const module of [...modules].reverse()) {
        try {
          await module.stop?.();
        } catch (error) {
          log.error({ err: error, module: module.name }, 'module stop failed');
        }
      }
    },
  };
}
