// Backend integration tests against the compose PostGIS/Redis (SPEC section 12.2). Every run gets its own database (cloned
// from a migrated template) and Redis key prefix, so parallel runs never interfere; files run one at a time.
import { defineConfig } from 'vitest/config';

import { SHARED_SOURCE_ALIAS } from './vitest.config.js';

export default defineConfig({
  resolve: { alias: SHARED_SOURCE_ALIAS },
  test: {
    name: 'integration',
    include: ['test/integration/**/*.int.test.ts'],
    environment: 'node',
    globalSetup: ['test/setup/global-setup.ts'],
    setupFiles: ['test/setup/env.ts'],
    fileParallelism: false,
    testTimeout: 20_000,
    hookTimeout: 60_000,
    teardownTimeout: 30_000,
  },
});
