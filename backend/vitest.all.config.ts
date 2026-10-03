// Combined backend coverage gate: unit + integration together (SPEC section 12.4, run by T9 and DoD 2). Needs the compose
// infra. Measures src/** except the process entry and the scripts exercised outside Vitest workers.
import { defineConfig } from 'vitest/config';

import { SHARED_SOURCE_ALIAS } from './vitest.config.js';

export default defineConfig({
  resolve: { alias: SHARED_SOURCE_ALIAS },
  test: {
    projects: ['./vitest.config.ts', './vitest.integration.config.ts'],
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      exclude: ['src/**/*.test.ts', 'src/main.ts', 'src/scripts/{migrate,seed,export-openapi}.ts'],
      reporter: ['text-summary', 'text'],
      thresholds: { lines: 80, branches: 70 },
    },
  },
});
