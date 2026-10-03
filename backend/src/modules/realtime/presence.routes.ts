/** `GET /api/v1/presence` (SPEC section 6.4): the presence list for clients whose WebSocket is down (limited mode, section 7.12). */
import { PresenceListResponseSchema } from '@snapland/shared';

import { SECURITY_BEARER, withProblems } from '../../infra/http/openapi.js';
import type { AppInstance } from '../../infra/http/types.js';
import type { PresenceService } from './presence.js';

export function registerPresenceRoutes(app: AppInstance, presence: PresenceService): void {
  app.get(
    '/api/v1/presence',
    {
      // Authenticated at route level: the default per-user `api` rate-limit scope applies (section 10.1).
      onRequest: [app.authenticate],
      schema: {
        summary: 'Online users (<= 500 entries, most recently updated first)',
        tags: ['realtime'],
        security: SECURITY_BEARER,
        response: withProblems({ 200: PresenceListResponseSchema }, 401),
      },
    },
    async () => presence.snapshot(),
  );
}
