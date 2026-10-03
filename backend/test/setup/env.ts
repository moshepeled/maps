/**
 * Worker setup of the integration project: applies the run's environment (database, Redis prefix, limits) provided by
 * the global setup, so `loadConfig(process.env)` in `createTestApp` sees exactly this run's resources. Every other
 * backend variable inherited from the shell is cleared first: tests start from the schema defaults plus the provided
 * overrides, whatever the developer exported (SPEC section 12.2, hermetic runs).
 */
import { inject } from 'vitest';

import { CONFIG_KEYS } from '../../src/config/env.js';

const provided = inject('snaplandTestEnv');
for (const key of CONFIG_KEYS) {
  if (!(key in provided)) Reflect.deleteProperty(process.env, key);
}
Object.assign(process.env, provided);
