/**
 * `app.requireRole('admin')` (SPEC section 3.3, section 10.7.5): reads the caller's CURRENT role and disabled flag through the user
 * directory on every admin request (one indexed read), so `grant-admin`/`revoke-admin`/`disable` take effect on the
 * next request instead of after the access token expires.
 */
import type { preHandlerAsyncHookHandler } from 'fastify';

import type { UserDirectory } from '../directory/types.js';
import { ForbiddenError, UnauthorizedError } from './errors.js';

export function createRequireRole(users: UserDirectory): (role: 'admin') => preHandlerAsyncHookHandler {
  return (role) =>
    async function requireRole(request) {
      if (request.auth === null) throw new UnauthorizedError('UNAUTHENTICATED', 'Authentication required.');
      const profile = (await users.getProfiles([request.auth.userId])).get(request.auth.userId);
      if (profile === undefined || profile.disabled || profile.role !== role) {
        throw new ForbiddenError('FORBIDDEN', 'This endpoint requires the admin role.');
      }
    };
}
