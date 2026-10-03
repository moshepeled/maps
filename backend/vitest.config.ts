// Backend unit tests (pure logic only, no network I/O) and the unit coverage gate of `npm run verify` (SPEC section 12.4).
import { fileURLToPath } from 'node:url';

import { defineConfig } from 'vitest/config';

/**
 * The unit coverage set: an explicit list of pure modules. I/O adapters are proven by integration tests and measured
 * by the combined gate (vitest.all.config.ts).
 */
const UNIT_COVERAGE_SET = [
  'src/config/env.ts',
  'src/infra/timeout.ts',
  'src/infra/db/errors.ts',
  'src/infra/http/{errors,problem,request-context}.ts',
  'src/infra/auth/access-tokens.ts',
  'src/infra/cache/{key-plan,l2-codec}.ts',
  'src/infra/ratelimit/in-memory.ts',
  'src/infra/audit/{coalescer,request-audit-tracker,buffered-writer,normalize}.ts',
  'src/infra/events/in-memory.ts',
  'src/infra/drafts/types.ts',
  'src/modules/auth/{passwords,rotation,palette}.ts',
  'src/modules/areas/{merge,cursor,areas.mapper,bbox-params,page-budget,http-caching,area-input,geometry-pipeline}.ts',
  'src/modules/realtime/{outbound-queue,token-bucket,interest,draft-coalescer,invalid-accounting}.ts',
];

export const SHARED_SOURCE_ALIAS = {
  '@snapland/shared': fileURLToPath(new URL('../packages/shared/src/index.ts', import.meta.url)),
};

export default defineConfig({
  resolve: { alias: SHARED_SOURCE_ALIAS },
  test: {
    name: 'unit',
    include: ['src/**/*.test.ts'],
    environment: 'node',
    coverage: {
      provider: 'v8',
      include: UNIT_COVERAGE_SET,
      exclude: ['src/**/*.test.ts'],
      reporter: ['text-summary', 'text'],
      thresholds: { lines: 85, branches: 80, functions: 85 },
    },
  },
});
