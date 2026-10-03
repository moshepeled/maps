/**
 * Graceful degradation (R14; UX C-16, UX-AC-65 - 67): with the WebSocket refused, the pill goes to Limited after the
 * 10 s grace, the map keeps working, and a new area is still saved over REST and shown.
 */
import { expect, test } from '@playwright/test';

import { clickMap, newUser, openSession, quietPlace, stamp } from '../support/session.js';

test('R14 UX-AC-65 the WebSocket refused: Limited, and drawing and saving still work over REST', async ({
  browser,
}) => {
  test.setTimeout(90_000);
  const user = await newUser('limited', 'Limited Tester');
  const { context, page } = await openSession(browser, user, {
    center: quietPlace(),
    zoom: 15,
    blockWebSocket: true,
  });
  await expect(page.getByTestId('connection-status')).toHaveAttribute('data-state', 'limited', {
    timeout: 45_000,
  });
  // The view may hold areas of earlier runs (the Negev is shared by every run): count from what it loaded.
  const summary = page.getByTestId('analysis-summary').first();
  const areasBefore = Number(await summary.getAttribute('data-count'));

  await page.getByTestId('draw-button').click();
  await clickMap(page, 0.4, 0.4);
  await clickMap(page, 0.6, 0.4);
  await clickMap(page, 0.5, 0.6);
  await page.getByTestId('finish-button').click();
  const name = `Offline-ish ${stamp()}`;
  await page.getByTestId('area-name-input').fill(name);
  await page.getByTestId('save-area-submit').click();
  await expect(page.getByTestId('options-bar')).toHaveAttribute('data-content', 'selected', {
    timeout: 10_000,
  });
  await expect(page.getByTestId('area-panel-name')).toHaveText(name);
  await expect(summary).toHaveAttribute('data-count', String(areasBefore + 1));
  await expect(page.getByTestId('connection-status')).toHaveAttribute('data-state', 'limited');
  await context.close();
});
