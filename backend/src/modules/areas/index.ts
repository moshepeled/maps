/**
 * Areas module (SPEC section 6.3): CRUD with the transport/domain split, the bbox contract (span cap, position budget, LOD),
 * versions (also of soft-deleted areas), field-level merge, idempotent creates, the change feed and the `areas` bus
 * events published before each mutation's reply. Wiring only: routes -> services -> repository.
 */
import type { ModuleFactory } from '../types.js';
import { AreasQueryService } from './areas-query.service.js';
import { registerAreasRoutes } from './areas.routes.js';
import { AreasService } from './areas.service.js';
import { MutationEffects } from './mutation-effects.js';

export const createAreasModule: ModuleFactory = (container) => {
  const { db, areaCache, events, audit, metrics, drafts, users } = container;
  const effects = new MutationEffects({ areaCache, events, audit, metrics });
  const service = new AreasService({ db, drafts, users, effects });
  const queries = new AreasQueryService({ db, areaCache, metrics });
  return {
    name: 'areas',
    register: (app) => {
      registerAreasRoutes(app, { service, queries });
      return Promise.resolve();
    },
  };
};
