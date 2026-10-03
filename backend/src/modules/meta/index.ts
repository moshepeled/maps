/** Meta module (SPEC section 6.4): client configuration and client error reports. */
import type { ModuleFactory } from '../types.js';
import { registerMetaRoutes } from './meta.routes.js';

export const createMetaModule: ModuleFactory = (container) => ({
  name: 'meta',
  register: (app) => {
    registerMetaRoutes(app, container);
    return Promise.resolve();
  },
});
