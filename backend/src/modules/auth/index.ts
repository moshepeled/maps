/**
 * Auth module (SPEC section 6.1, section 6.2): register, login, refresh, logout, me, sessions and WebSocket tickets. `app.ts`
 * registers `createAuthModule`; the user-admin CLI uses `createUserAdminService`.
 */
import type { ModuleFactory } from '../types.js';
import { registerAuthRoutes } from './auth.routes.js';
import { AuthService } from './auth.service.js';
import { createLoginFailureCounter } from './login-failures.js';
import { createPasswordHasher } from './passwords.js';
import { createRevocationNotifier } from './revocation-notifier.js';
import { SessionsService } from './sessions.service.js';

export const createAuthModule: ModuleFactory = (container) => {
  const logger = container.logger.child({ module: 'auth' });
  const notifier = createRevocationNotifier({
    revocations: container.revocations,
    events: container.events,
    logger,
  });
  const auth = new AuthService({
    db: container.db,
    accessTokens: container.accessTokens,
    audit: container.audit,
    auditCoalescer: container.auditCoalescer,
    metrics: container.metrics,
    logger,
    passwords: createPasswordHasher(),
    loginFailures: createLoginFailureCounter({
      redis: container.redis,
      keys: container.keys,
      clock: container.clock,
      logger,
    }),
    notifier,
    settings: {
      refreshTokenTtlS: container.config.REFRESH_TOKEN_TTL_S,
      sessionAbsoluteTtlS: container.config.SESSION_ABSOLUTE_TTL_S,
    },
  });
  const sessions = new SessionsService({
    db: container.db,
    audit: container.audit,
    notifier,
    wsTickets: container.wsTickets,
    logger,
  });
  return {
    name: 'auth',
    register: (app) => {
      registerAuthRoutes(app, { auth, sessions, cookieSecure: container.config.COOKIE_SECURE });
      return Promise.resolve();
    },
  };
};

export { createRevocationNotifier } from './revocation-notifier.js';
export { USER_ADMIN_OPS, UnknownUserError, createUserAdminService } from './user-admin.service.js';
export type { UserAdminOp, UserAdminResult } from './user-admin.service.js';
export { DUMMY_PASSWORD_HASH } from './passwords.js';
