/**
 * `app.authenticate` (SPEC section 3.3): onRequest hook that verifies `Authorization: Bearer <access token>`, checks the
 * revocation store and sets `request.auth`. Its 401s are marked on the request because an unauthenticated request is
 * not a user action for the audit trail (section 10.4).
 */
import type { onRequestAsyncHookHandler } from 'fastify';

import { UnauthorizedError } from '../http/errors.js';
import type { AccessTokenService } from './access-tokens.js';
import type { SessionRevocationStore } from './revocations.js';

const BEARER = /^Bearer ([A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)$/;

export function createAuthenticate(deps: {
  accessTokens: AccessTokenService;
  revocations: SessionRevocationStore;
}): onRequestAsyncHookHandler {
  return async function authenticate(request) {
    try {
      const match = BEARER.exec(request.headers.authorization ?? '');
      const token = match?.[1];
      if (token === undefined)
        throw new UnauthorizedError('UNAUTHENTICATED', 'A Bearer access token is required.');
      const claims = await deps.accessTokens.verify(token);
      if (await deps.revocations.isRevoked(claims.sessionId)) {
        throw new UnauthorizedError('SESSION_REVOKED', 'The session has been revoked.');
      }
      request.auth = claims;
    } catch (error) {
      request.authFailed = true;
      throw error;
    }
  };
}
