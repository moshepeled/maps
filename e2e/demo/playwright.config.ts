// Playwright configuration of the demo recorder (docs/demo/README.md). It is not part of the E2E suite: that config's
// testDir is ./tests, so `npm run test:e2e` never records. The recorder makes its own browser contexts (video, viewport,
// base URL), so nothing else is configured here.
import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: '.',
  testMatch: 'record-demo.ts',
  timeout: 10 * 60_000,
  expect: { timeout: 20_000 },
  workers: 1,
  retries: 0,
  reporter: 'list',
  outputDir: 'test-results',
});
