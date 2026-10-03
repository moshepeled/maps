/** `GET /api/v1/config` (public) and `POST /api/v1/client-errors` (user) - SPEC section 6.4. */
import { ClientErrorReportSchema, ConfigResponseSchema, LIMITS } from '@snapland/shared';
import { z } from 'zod';

import type { Container } from '../../container.js';
import { SECURITY_BEARER, withProblems } from '../../infra/http/openapi.js';
import { rateLimitRoute } from '../../infra/http/rate-limits.js';
import type { AppInstance } from '../../infra/http/types.js';
import { buildClientConfig, recordClientError } from './meta.service.js';

export function registerMetaRoutes(app: AppInstance, container: Container): void {
  const clientConfig = buildClientConfig(container.config);
  const logger = container.logger.child({ module: 'meta' });

  app.get(
    '/api/v1/config',
    {
      // Public, static and cacheable (max-age=60): deliberately unlimited, like /health (section 6.1, section 10.1).
      config: { rateLimit: false },
      schema: {
        summary: 'Client configuration and limits',
        tags: ['meta'],
        response: withProblems({ 200: ConfigResponseSchema }),
      },
    },
    (_request, reply) => {
      reply.header('Cache-Control', 'public, max-age=60');
      return clientConfig;
    },
  );

  app.post(
    '/api/v1/client-errors',
    {
      onRequest: [app.authenticate],
      bodyLimit: LIMITS.clientErrorBodyMaxBytes,
      config: { rateLimit: rateLimitRoute('client_errors') },
      schema: {
        summary: 'Report an SPA protocol error (logged and counted, never stored)',
        tags: ['meta'],
        security: SECURITY_BEARER,
        body: ClientErrorReportSchema,
        response: withProblems({ 204: z.null().describe('Accepted') }, 401, 413, 415),
      },
    },
    async (request, reply) => {
      recordClientError(request.body, request.actor(), { logger, metrics: container.metrics });
      return reply.code(204).send(null);
    },
  );
}
