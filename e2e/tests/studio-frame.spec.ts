/**
 * The Studio frame (user decisions D-4, D-5; UX-AC-111 ... 121): the dark default theme and the persisted light switch,
 * the docked frame whose map box never changes with the mode, the minimum text size, the tool rail's tooltips, the
 * options bar's content per mode, the status bar, and the overlay inspector at 1024 px that pans a shape out from
 * under itself.
 */
import type { Page } from '@playwright/test';
import { expect, test } from '@playwright/test';

import type { Box } from '../support/session.js';
import {
  boxOf,
  clickMap,
  createArea,
  intersects,
  latToY,
  lngToX,
  newUser,
  openSession,
  quietPlace,
  rectangle,
  stamp,
  xToLng,
  yToLat,
} from '../support/session.js';

const DESKTOP = { width: 1440, height: 900 };

async function theme(page: Page): Promise<string | undefined> {
  return page.evaluate(() => document.documentElement.dataset['theme']);
}

async function mapBox(page: Page): Promise<Box> {
  return boxOf(page.getByTestId('map'));
}

function sameBox(a: Box, b: Box): boolean {
  return ['x', 'y', 'width', 'height'].every(
    (key) => Math.abs(a[key as keyof Box] - b[key as keyof Box]) <= 0.5,
  );
}

/** The smallest rendered font size of visible text (UX v2: nothing below 11 px). */
async function smallestText(page: Page): Promise<{ size: number; text: string }> {
  return page.evaluate(() => {
    let smallest = { size: Infinity, text: '' };
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
      const text = node.textContent?.trim() ?? '';
      const parent = node.parentElement;
      if (text === '' || parent === null) continue;
      const rect = parent.getBoundingClientRect();
      const style = getComputedStyle(parent);
      if (rect.width < 2 || rect.height < 2 || style.visibility === 'hidden') continue;
      // Visually hidden text (screen-reader copy) is clipped to 1 px, filtered above.
      const size = Number.parseFloat(style.fontSize);
      if (size < smallest.size) smallest = { size, text: text.slice(0, 40) };
    }
    return smallest;
  });
}

test.describe('themes (D-5)', () => {
  test('UX-AC-111 dark by default, even when the OS prefers light', async ({ browser }) => {
    const user = await newUser('theme', 'Theme Tester');
    const { context, page } = await openSession(browser, user, {
      center: quietPlace(),
      zoom: 15,
      colorScheme: 'light',
    });
    expect(await theme(page)).toBe('dark');
    await context.close();
  });

  test('UX-AC-112 the user menu switches to Light; it persists across a reload in snapland.theme', async ({
    browser,
  }) => {
    const user = await newUser('light', 'Light Tester');
    const { context, page } = await openSession(browser, user, { center: quietPlace(), zoom: 15 });
    await page.getByTestId('user-menu-button').click();
    await page.getByTestId('theme-option-light').click();
    expect(await theme(page)).toBe('light');
    await expect(page.getByTestId('theme-option-light')).toHaveAttribute('aria-checked', 'true');
    expect(await page.evaluate(() => localStorage.getItem('snapland.theme'))).toBe('light');
    await page.reload();
    await expect(page.getByTestId('map')).toBeVisible();
    expect(await theme(page)).toBe('light');
    await context.close();
  });
});

test.describe('docked frame (UX-AC-115 - 117, 120)', () => {
  for (const viewport of [DESKTOP, { width: 1280, height: 720 }]) {
    test(`UX-AC-115 at ${String(viewport.width)} × ${String(viewport.height)}: fixed chrome sizes; the map box never changes with the mode`, async ({
      browser,
    }) => {
      const user = await newUser('frame', 'Frame Tester');
      const center = quietPlace();
      const { context, page } = await openSession(browser, user, { viewport, center, zoom: 15 });
      const sizes: [string, 'height' | 'width', number][] = [
        ['title-bar', 'height', 44],
        ['tool-rail', 'width', 52],
        ['options-bar', 'height', 44],
        ['inspector', 'width', 352],
        ['status-bar', 'height', 26],
      ];
      const browse = await mapBox(page);
      for (const [id, side, size] of sizes) {
        const box = await boxOf(page.getByTestId(id).first());
        expect(Math.abs(box[side] - size), `${id} ${side}`).toBeLessThanOrEqual(1);
        expect(intersects(box, browse), `${id} overlaps the map`).toBe(false);
      }
      await expect(page.getByTestId('options-bar')).toHaveAttribute('data-content', 'browse');

      await page.keyboard.press('d');
      await expect(page.getByTestId('options-bar')).toHaveAttribute('data-content', 'drawing');
      await clickMap(page, 0.4, 0.4);
      await clickMap(page, 0.6, 0.4);
      await clickMap(page, 0.5, 0.6);
      await expect(page.getByTestId('point-count')).toHaveAttribute('data-count', '3');
      expect(sameBox(await mapBox(page), browse), 'Drawing').toBe(true);

      await page.getByTestId('finish-button').click();
      await expect(page.getByTestId('options-bar')).toHaveAttribute('data-content', 'naming');
      expect(sameBox(await mapBox(page), browse), 'Naming').toBe(true);
      await page.getByTestId('area-name-input').fill(`Frame ${stamp()}`);
      await page.getByTestId('save-area-submit').click();
      await expect(page.getByTestId('options-bar')).toHaveAttribute('data-content', 'selected');
      expect(sameBox(await mapBox(page), browse), 'AreaSelected').toBe(true);

      await page.getByTestId('edit-shape-button').click();
      await expect(page.getByTestId('options-bar')).toHaveAttribute('data-content', 'editing');
      await expect(page.getByTestId('point-handle')).toHaveCount(3);
      expect(sameBox(await mapBox(page), browse), 'EditingShape').toBe(true);
      await page.getByTestId('cancel-edit-button').click();
      await expect(page.getByTestId('options-bar')).toHaveAttribute('data-content', 'selected');

      const smallest = await smallestText(page);
      expect(smallest.size, `"${smallest.text}"`).toBeGreaterThanOrEqual(11);
      await context.close();
    });
  }

  test('UX-AC-116 rail tools show "{label}, {key}" on hover and on keyboard focus; Esc dismisses it', async ({
    browser,
  }) => {
    const user = await newUser('rail', 'Rail Tester');
    const { context, page } = await openSession(browser, user, { center: quietPlace(), zoom: 15 });
    await page.getByTestId('areas-button').hover();
    const tip = page.getByTestId('tool-rail').getByRole('tooltip');
    await expect(tip).toHaveText('Areas in view · A');
    await page.mouse.move(700, 450);
    await expect(tip).toHaveCount(0);
    await page.getByTestId('draw-button').focus();
    await page.keyboard.press('Tab');
    await expect(page.getByTestId('rail-edit-button')).toBeFocused();
    await expect(tip).toContainText('Edit shape · E');
    await page.keyboard.press('Escape');
    await expect(tip).toHaveCount(0);
    await expect(page.getByTestId('rail-edit-button')).toBeFocused();
    await context.close();
  });

  test('UX-AC-120 the status bar: zoom, scale, summary and context hints; nothing in it takes focus', async ({
    browser,
  }) => {
    const user = await newUser('status', 'Status Tester');
    const { context, page } = await openSession(browser, user, { center: quietPlace(), zoom: 15 });
    const bar = page.getByTestId('status-bar');
    for (const id of ['coord-readout', 'status-zoom', 'scale-bar', 'analysis-summary', 'status-key-hints'])
      await expect(bar.getByTestId(id)).toBeVisible();
    await expect(page.getByTestId('status-zoom')).toHaveAttribute('data-zoom', '15');
    await expect(page.getByTestId('status-key-hints')).toHaveAttribute('data-context', 'browse');
    expect(await bar.locator('button, a[href], input, select, [tabindex]').count()).toBe(0);
    expect(await bar.locator('[aria-live]').count()).toBe(0);
    await context.close();
  });
});

test.describe('overlay inspector (UX-AC-121)', () => {
  test('UX-AC-121 at 1024 x 768 a small area near the right edge opens the overlay, which pans it out from under itself', async ({
    browser,
  }) => {
    const user = await newUser('overlay', 'Overlay Tester');
    const center = quietPlace();
    const zoom = 16;
    // 1024 x 768: the map is 972 x 698 (rail 52; title 44 + options bar 44; status 26). An area 60 px wide whose
    // centre is 380 px right of the map centre: under the 340 px overlay once it opens.
    const cx = lngToX(center.lng, zoom) + 380;
    const cy = latToY(center.lat, zoom);
    const ring = rectangle(
      xToLng(cx - 30, zoom),
      yToLat(cy + 30, zoom),
      xToLng(cx + 30, zoom) - xToLng(cx - 30, zoom),
      yToLat(cy - 30, zoom) - yToLat(cy + 30, zoom),
    );
    await createArea(user, `Edge ${stamp()}`, ring);
    const { context, page } = await openSession(browser, user, {
      viewport: { width: 1024, height: 768 },
      center,
      zoom,
    });
    const inspector = page.getByTestId('inspector');
    await expect(inspector).toHaveAttribute('data-open', 'false');
    const before = await mapBox(page);
    await expect
      .poll(
        async () => {
          await page.mouse.click(before.x + before.width / 2 + 380, before.y + before.height / 2);
          return inspector.getAttribute('data-open');
        },
        { timeout: 15_000, intervals: [500, 1000] },
      )
      .toBe('true');
    await expect(inspector).toHaveAttribute('data-layout', 'overlay');
    const overlay = await boxOf(inspector);
    for (const id of ['attribution', 'status-bar'])
      expect(intersects(overlay, await boxOf(page.getByTestId(id))), id).toBe(false);
    await expect
      .poll(async () => intersects(await boxOf(page.locator('path.ov-selected.ov-core').first()), overlay), {
        timeout: 5_000,
      })
      .toBe(false);
    expect(sameBox(await mapBox(page), before)).toBe(true);
    await context.close();
  });
});
