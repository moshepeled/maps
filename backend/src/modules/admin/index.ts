/** Admin module (SPEC section 6.4, section 10.4): row-level audit drill-down and base-table audit analytics, admin role only. */
import type { ModuleFactory } from '../types.js';
import { registerAdminRoutes } from './admin.routes.js';
import { AdminService } from './admin.service.js';

export const createAdminModule: ModuleFactory = (container) => {
  const service = new AdminService({
    db: container.db,
    users: container.users,
    audit: container.audit,
    clock: container.clock,
  });
  return {
    name: 'admin',
    register: (app) => {
      registerAdminRoutes(app, service);
      return Promise.resolve();
    },
  };
};
