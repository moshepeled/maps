/**
 * Output encoding (R21, SPEC section 10.7.1): an area name and a display name that are HTML render as text everywhere - * the Areas list, the selection, the hover tooltip - and never run.
 */
import { expect, test } from '@playwright/test';

import { createArea, newUser, openSession, quietPlace, rectangle, stamp } from '../support/session.js';

const PAYLOAD = '<img src=x onerror=window.__xss=1>';

test('R21 HTML in an area name and a display name is shown as text and never executes', async ({
  browser,
}) => {
  const user = await newUser('xss', PAYLOAD);
  const center = quietPlace();
  const name = `${PAYLOAD} ${stamp()}`;
  await createArea(user, name, rectangle(center.lng - 0.002, center.lat - 0.001, 0.004, 0.002));
  const { context, page, errors } = await openSession(browser, user, { center, zoom: 15 });

  await page.getByTestId('areas-button').click();
  // This run's row, by its full name in `title` (the payload has no double quote to escape).
  const item = page.locator(`[data-testid="areas-list-item"]:has(.n[title="${name}"])`);
  await expect(item).toHaveCount(1, { timeout: 15_000 });
  // Long names are shortened on screen; the full text is the row's `title` (both are text, never markup).
  await expect(item).toContainText('<img src=x');
  await expect(item.locator('.n')).toHaveAttribute('title', name);
  await item.click();
  await expect(page.getByTestId('area-panel-name')).toHaveText(name);

  // The hover tooltip over the area at the map centre.
  const map = await page.getByTestId('map').boundingBox();
  if (map === null) throw new Error('no map');
  await page.mouse.move(map.x + map.width / 2, map.y + map.height / 2);
  await page.mouse.move(map.x + map.width / 2 + 2, map.y + map.height / 2 + 1);
  const tooltip = page.getByTestId('area-tooltip');
  await expect(tooltip).toHaveAttribute('title', name, { timeout: 5_000 });
  await expect(tooltip).toContainText('<img src=x');

  expect(await page.locator('img[src="x"]').count()).toBe(0);
  expect(await page.evaluate(() => (window as unknown as { __xss?: unknown }).__xss)).toBeUndefined();
  expect(errors).toEqual([]);
  await context.close();
});
