// Unit tests and the coverage gate of @snapland/shared (SPEC section 12.4: lines >= 90 %, branches >= 85 %).
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    environment: 'node',
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      exclude: ['src/**/*.test.ts', 'src/testing/**', 'src/index.ts'],
      reporter: ['text-summary', 'text'],
      thresholds: { lines: 90, branches: 85 },
    },
  },
});
