/** Health module (SPEC section 10.9): liveness, readiness and the Prometheus endpoint. */
import type { ModuleFactory } from '../types.js';
import { registerHealthRoutes } from './health.routes.js';

export const createHealthModule: ModuleFactory = (container) => ({
  name: 'health',
  register: (app) => {
    registerHealthRoutes(app, container);
    return Promise.resolve();
  },
});
