// Unit/component tests of the SPA and its coverage gate (SPEC section 12.4: lines >= 70 % over the listed directories).
import { fileURLToPath } from 'node:url';

import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [react()],
  resolve: {
    // The test-only entry first: an alias also matches its subpaths, and the first matching entry wins.
    alias: {
      '@snapland/shared/testing': fileURLToPath(
        new URL('../packages/shared/src/testing/protocol-examples.ts', import.meta.url),
      ),
      '@snapland/shared': fileURLToPath(new URL('../packages/shared/src/index.ts', import.meta.url)),
    },
  },
  test: {
    include: ['src/**/*.test.{ts,tsx}'],
    environment: 'jsdom',
    setupFiles: ['src/test/setup.ts'],
    // docs/design/tokens.css is imported `?raw` by the parity test (timings); other CSS stays unprocessed in tests.
    css: { include: [/tokens\.css/] },
    coverage: {
      provider: 'v8',
      include: [
        'src/state/**/*.{ts,tsx}',
        'src/realtime/**/*.{ts,tsx}',
        'src/lib/**/*.{ts,tsx}',
        'src/map/{crossfade,crs,itm,safe-dom,viewportSync}.ts',
      ],
      exclude: ['src/**/*.test.{ts,tsx}'],
      reporter: ['text-summary', 'text'],
      thresholds: { lines: 70 },
    },
  },
});
