// Playwright configuration of the E2E suite (SPEC section 12.2). Specs run against the compose stack built with
// docker-compose.e2e.yml (E2E hooks + ITM layer on); `E2E_BASE_URL` points at nginx (default http://localhost:5173).
//
// Gotchas learned at the integration gate:
// - Drawing the tel_aviv_1km_square fixture at z16 in 1280x720: centre the view at lat 32.0850, not on the fixture's
//   centre (32.0845), or the top corners fall under the drawing HUD and a click lands on it.
// - page.unrouteAll() does not remove page.routeWebSocket() handlers: to "unblock" the socket, flip a flag the handler
//   reads (close while blocked, ws.connectToServer() afterwards).
// - A bbox read on a fresh Redis key prefix bypasses the cache (no epoch yet, SPEC section 10.2): warm it until X-Cache is
//   HIT-L1 before asserting on cache behaviour.
import { defineConfig, devices } from '@playwright/test';

const baseURL = process.env['E2E_BASE_URL'] ?? 'http://localhost:5173';

export default defineConfig({
  testDir: './tests',
  timeout: 60_000,
  expect: { timeout: 10_000 },
  // Two browser contexts (Alice and Bob) share one stack: specs run one at a time for deterministic realtime assertions.
  fullyParallel: false,
  workers: 1,
  retries: 0,
  forbidOnly: true,
  reporter: [['list'], ['html', { open: 'never', outputFolder: 'playwright-report' }]],
  outputDir: 'test-results',
  use: {
    baseURL,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'off',
  },
  projects: [
    {
      name: 'desktop',
      testIgnore: /ux-touch\.spec\.ts$/,
      use: { ...devices['Desktop Chrome'], viewport: { width: 1280, height: 720 } },
    },
    {
      // Touch-only criteria (UX-AC-22, 70, 81-84, 104); specs switch between 360x640 and 390x844 per test.
      name: 'mobile',
      testMatch: /ux-touch\.spec\.ts$/,
      use: { ...devices['Pixel 5'], viewport: { width: 360, height: 640 }, hasTouch: true, isMobile: true },
    },
  ],
});
