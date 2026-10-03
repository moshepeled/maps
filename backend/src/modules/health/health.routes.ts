/** `/health/live`, `/health/ready` and `/metrics` (SPEC section 10.9, section 10.8). */
import { LiveResponseSchema, ReadyResponseSchema } from '@snapland/shared';

import { APP_VERSION } from '../../config/version.js';
import type { Container } from '../../container.js';
import type { AppInstance } from '../../infra/http/types.js';
import { evaluateReadiness } from './health.service.js';

export function registerHealthRoutes(app: AppInstance, container: Container): void {
  const startedAtMs = container.clock.now();
  const uptimeS = (): number => Math.floor((container.clock.now() - startedAtMs) / 1000);

  app.get(
    '/health/live',
    {
      schema: {
        summary: 'Liveness: 200 while the event loop runs (no dependency checks)',
        tags: ['health'],
        response: { 200: LiveResponseSchema },
      },
    },
    () => ({ status: 'ok' as const, instanceId: container.instanceId, uptimeS: uptimeS() }),
  );

  app.get(
    '/health/ready',
    {
      schema: {
        summary: 'Readiness: database, Redis, migrations and shutdown state (503 when not ready)',
        tags: ['health'],
        response: { 200: ReadyResponseSchema, 503: ReadyResponseSchema },
      },
    },
    async (_request, reply) => {
      const report = await evaluateReadiness({
        db: container.db,
        redis: container.redis.cmd,
        cacheRedis: container.redis.cache,
        isShuttingDown: () => app.lifecycleState.shuttingDown,
      });
      reply.header('Cache-Control', 'no-store');
      return reply
        .code(report.status === 'fail' ? 503 : 200)
        .send({ ...report, instanceId: container.instanceId, version: APP_VERSION, uptimeS: uptimeS() });
    },
  );

  if (container.config.METRICS_ENABLED) {
    app.get('/metrics', { schema: { hide: true } }, async (_request, reply) => {
      await container.metrics.sample();
      const body = await container.metrics.registry.metrics();
      return reply.type(container.metrics.registry.contentType).send(body);
    });
  }
}
