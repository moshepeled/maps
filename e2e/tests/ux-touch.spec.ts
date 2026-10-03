/**
 * Phone frame and touch rules (UX section 3.2 [M], UX-AC-122; Studio fix round 2), at 390 x 844 with a touch screen:
 * the frame's regions, the free strip a selected or reshaped area is brought into (between the HUD or the title bar
 * and the sheet or the bottom bar), the list tap that fits the area above the peek sheet, and one own toast whose
 * replaced Undo stays reachable from the user menu.
 */
import type { Page } from '@playwright/test';
import { expect, test } from '@playwright/test';

import type { Box } from '../support/session.js';
import {
  boxOf,
  createArea,
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

const PHONE = { width: 390, height: 844 };
/** 390 x 844 in Browse: the 48 px title bar above the map, the 72 px bottom bar below it. */
const MAP_TOP = 48;
const MAP_HEIGHT = PHONE.height - 48 - 72;
/** Half of a 44 px touch target: a handle centre this close to an edge has part of its target cut off. */
const HALF_TARGET = 22;

/** An area `height` x `width` px, its top edge `fromTop` px below the map's top edge, horizontally centred. */
function areaNearTop(
  center: { lat: number; lng: number },
  zoom: number,
  fromTop: number,
  size: { width: number; height: number },
) {
  const cx = lngToX(center.lng, zoom);
  const top = latToY(center.lat, zoom) - MAP_HEIGHT / 2 + fromTop;
  const north = yToLat(top, zoom);
  const south = yToLat(top + size.height, zoom);
  const west = xToLng(cx - size.width / 2, zoom);
  const east = xToLng(cx + size.width / 2, zoom);
  return rectangle(west, south, east - west, north - south);
}

/** The screen box of the selected area's outline (the accent core drawn over the canvas). */
async function selectedBox(page: Page): Promise<Box> {
  return boxOf(page.locator('path.ov-selected.ov-core').first());
}

/** Taps until the tap selects (the areas of the view load after sign-in). */
async function tapToSelect(page: Page, x: number, y: number): Promise<void> {
  await expect
    .poll(
      async () => {
        await page.touchscreen.tap(x, y);
        return page.getByTestId('area-sheet').isVisible();
      },
      { timeout: 15_000, intervals: [500, 1000, 1000] },
    )
    .toBe(true);
}

test.describe('phone frame (UX-AC-122)', () => {
  test('UX-AC-122 title bar 48 px, no desktop chrome; the Drawing HUD docks between title bar and map', async ({
    browser,
  }) => {
    const user = await newUser('frame', 'Phone Frame');
    const { context, page } = await openSession(browser, user, {
      viewport: PHONE,
      touch: true,
      center: quietPlace(),
      zoom: 15,
    });
    const title = await boxOf(page.getByTestId('title-bar'));
    expect(Math.abs(title.height - 48)).toBeLessThanOrEqual(1);
    for (const id of ['tool-rail', 'options-bar', 'inspector', 'status-bar'])
      await expect(page.getByTestId(id)).toBeHidden();
    const map = await boxOf(page.getByTestId('map'));
    expect(Math.abs(map.y - MAP_TOP)).toBeLessThanOrEqual(1);
    await page.getByTestId('draw-button').tap();
    const hud = await boxOf(page.getByTestId('draw-hud'));
    expect(hud.height).toBeLessThanOrEqual(58);
    const drawingMap = await boxOf(page.getByTestId('map'));
    expect(Math.abs(drawingMap.y - (hud.y + hud.height))).toBeLessThanOrEqual(1);
    await expect(page.getByTestId('cancel-draw-button')).toBeVisible();
    await expect(page.getByTestId('finish-button')).toBeVisible();
    await context.close();
  });
});

test.describe('free strip on phones (UX section 3.2 [M])', () => {
  test('UX section 3.2 an area 20 px below the map top: Edit shape pans every point handle clear of the HUD and the bottom bar', async ({
    browser,
  }) => {
    const user = await newUser('strip', 'Strip Tester');
    const center = quietPlace();
    const zoom = 16;
    await createArea(user, `Top ${stamp()}`, areaNearTop(center, zoom, 20, { width: 120, height: 90 }));
    const { context, page } = await openSession(browser, user, {
      viewport: PHONE,
      touch: true,
      center,
      zoom,
    });
    const map = await boxOf(page.getByTestId('map'));
    expect(Math.abs(map.y - MAP_TOP)).toBeLessThanOrEqual(1);
    await tapToSelect(page, map.x + map.width / 2, map.y + 20 + 45);
    await expect(page.getByTestId('area-sheet')).toHaveAttribute('data-snap', 'peek');

    await page.getByTestId('edit-shape-button').tap();
    await expect(page.getByTestId('draw-hud')).toBeVisible();
    await expect(page.getByTestId('point-handle')).toHaveCount(4);
    // The pan is animated: poll until the handles have settled inside the strip.
    await expect
      .poll(
        async () => {
          const hud = await boxOf(page.getByTestId('draw-hud'));
          const bar = await boxOf(page.getByTestId('bottom-bar'));
          const centres = await page.getByTestId('point-handle').evaluateAll((handles: Element[]) =>
            handles.map((handle: Element) => {
              const rect = handle.getBoundingClientRect();
              return rect.top + rect.height / 2;
            }),
          );
          return centres.every((y) => y >= hud.y + hud.height + HALF_TARGET && y <= bar.y - HALF_TARGET);
        },
        { timeout: 5_000 },
      )
      .toBe(true);
    await context.close();
  });

  test('UX C-10 a list tap fits the area between the title bar and the peek sheet, without zooming out', async ({
    browser,
  }) => {
    const user = await newUser('list', 'List Tapper');
    const center = quietPlace();
    const zoom = 15;
    // About 410 m square: ~100 px at z15 here, well inside the free strip at the current zoom.
    const side = 0.0037;
    const name = `Square ${stamp()}`;
    await createArea(user, name, rectangle(center.lng - 0.004, center.lat + 0.002, side, side * 0.86));
    const { context, page } = await openSession(browser, user, {
      viewport: PHONE,
      touch: true,
      center,
      zoom,
    });
    await page.getByTestId('areas-button').tap();
    await expect(page.getByTestId('area-sheet')).toHaveAttribute('data-snap', 'expanded');
    const item = page.getByTestId('areas-list-item').filter({ hasText: name });
    await expect(item).toHaveCount(1, { timeout: 15_000 });
    await item.tap();
    await expect(page.getByTestId('area-sheet')).toHaveAttribute('data-snap', 'peek');
    await expect
      .poll(
        async () => {
          const title = await boxOf(page.getByTestId('title-bar'));
          const sheet = await boxOf(page.getByTestId('area-sheet'));
          const area = await selectedBox(page);
          return (
            area.y >= title.y + title.height + 16 &&
            area.y + area.height <= sheet.y - 16 &&
            // Not a speck: at least the ~100 px it had at the starting zoom (the fit never zoomed out).
            area.width >= 95
          );
        },
        { timeout: 5_000 },
      )
      .toBe(true);
    await context.close();
  });
});

test.describe('toasts on phones (UX section 3.2 [M], C-18)', () => {
  test('C-18 one own toast; the replaced Undo moves to the user menu and never resurfaces as a toast', async ({
    browser,
  }) => {
    const user = await newUser('undo', 'Undo Tester');
    const center = quietPlace();
    const name = stamp();
    // Side by side, so the second is still in view after the list tap flew to the first.
    await createArea(user, `PU1 ${name}`, rectangle(center.lng - 0.0009, center.lat, 0.0008, 0.0006));
    await createArea(user, `PU2 ${name}`, rectangle(center.lng + 0.0001, center.lat, 0.0008, 0.0006));
    const { context, page } = await openSession(browser, user, {
      viewport: PHONE,
      touch: true,
      center,
      zoom: 16,
    });
    await page.getByTestId('areas-button').tap();
    for (const which of ['PU1', 'PU2']) {
      // After a delete the list comes back (expanded) by itself.
      await expect(page.getByTestId('area-sheet')).toHaveAttribute('data-snap', 'expanded');
      // ...starting at its header: the title and its close button are not scrolled out of the sheet.
      await expect(page.locator('#areas-list-title')).toBeInViewport();
      const item = page.getByTestId('areas-list-item').filter({ hasText: `${which} ${name}` });
      await expect(item).toHaveCount(1, { timeout: 15_000 });
      await item.tap();
      await page.getByTestId('delete-area-button').tap();
      await expect(page.getByTestId('toast').filter({ hasText: which })).toBeVisible();
    }
    await expect(page.getByTestId('toast')).toHaveCount(1);
    await expect(page.getByTestId('toast')).toContainText('PU2');
    await page.getByTestId('user-menu-button').tap();
    await expect(page.getByTestId('menu-undo-last')).toContainText('PU1');
    await page.keyboard.press('Escape');
    await context.close();
  });
});
