/**
 * Base-map switch (user decision D-1; R26 - R29, R32, R35; UX section 7, UX-AC-43 - 49): Map <-> Aerial mid-draw keeps the
 * centre, the placed points (drawn at the same lat/lng on both projections) and the live area; a point placed on Aerial
 * joins the drawing; the attribution follows the visible layer; `L` toggles back. Aerial is the GovMap 2022 ITM cache
 * (EPSG:2039, `data-base-layer=govmap-itm`), on its own map instance.
 */
import type { Page } from '@playwright/test';
import { expect, test } from '@playwright/test';

import { boxOf, clickMap, newUser, openSession, quietPlace } from '../support/session.js';

interface LatLng {
  lat: number;
  lng: number;
}

/** ~ 10 m: under 3 px at z15 and under 4 px at the ITM level it maps to; a projection mix-up is off by far more. */
const SAME_PLACE_DEG = 1e-4;

function readout(page: Page) {
  return page.getByTestId('coord-readout').first();
}

/** Both readout attributes in one read, so they come from the same render. */
async function readLatLng(page: Page): Promise<LatLng> {
  return readout(page).evaluate((element: HTMLElement) => ({
    lat: Number(element.dataset['lat']),
    lng: Number(element.dataset['lng']),
  }));
}

/** Moves the pointer onto the inspector: no provisional point, and the readout shows the map centre. */
async function pointerOffMap(page: Page): Promise<void> {
  const inspector = await boxOf(page.getByTestId('inspector'));
  await page.mouse.move(inspector.x + inspector.width / 2, inspector.y + inspector.height - 40);
  await expect(readout(page).locator('.coord-prefix')).toHaveCount(1);
}

async function centre(page: Page): Promise<LatLng> {
  await pointerOffMap(page);
  return readLatLng(page);
}

/** The live area with the pointer off the map (no provisional point). */
async function liveKm2(page: Page): Promise<number> {
  await pointerOffMap(page);
  return Number(await page.getByTestId('area-readout').first().getAttribute('data-km2'));
}

/**
 * Where each placed point is drawn, as lat/lng: the pointer readout over the centre of its glyph. The readout converts
 * through the visible layer's projection, so this is the geographic position of the point as it appears on screen.
 */
async function drawnPoints(page: Page): Promise<LatLng[]> {
  // A cross-CRS switch keeps the outgoing map instance underneath until the new tiles load, at most 5 s (SPEC section 8.4);
  // once it is gone, the glyphs are those of the visible map, one per point.
  await expect(page.locator('.leaflet-container')).toHaveCount(1);
  await expect(page.locator('.snap-point')).toHaveCount(
    Number(await page.getByTestId('point-count').getAttribute('data-count')),
  );
  // Found and measured in one task: the glyphs are rebuilt whenever the pointer enters or leaves the first point.
  const centres = await page.evaluate(() =>
    [...document.querySelectorAll('.snap-point')].map((glyph) => {
      const box = glyph.getBoundingClientRect();
      return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
    }),
  );
  const places: LatLng[] = [];
  for (const { x, y } of centres) {
    await pointerOffMap(page);
    await page.mouse.move(x, y);
    await expect(readout(page).locator('.coord-prefix')).toHaveCount(0);
    places.push(await readLatLng(page));
  }
  return places;
}

/** The larger of the latitude and longitude differences, in degrees. */
function offset(a: LatLng, b: LatLng): number {
  return Math.max(Math.abs(a.lat - b.lat), Math.abs(a.lng - b.lng));
}

/** How far the furthest point moved between two `drawnPoints` readings (Infinity when one is missing). */
function largestMove(now: LatLng[], before: LatLng[]): number {
  expect(now).toHaveLength(before.length);
  return Math.max(...before.map((place, index) => offset(now[index] ?? { lat: Infinity, lng: 0 }, place)));
}

test('R26 R28 R29 R32 R35 Map -> Aerial -> Map mid-draw keeps the centre, the points and the area; attribution follows', async ({
  browser,
}) => {
  const user = await newUser('layers', 'Layer Tester');
  const { context, page, errors } = await openSession(browser, user, { center: quietPlace(), zoom: 15 });
  const map = page.getByTestId('map');
  const attribution = page.getByTestId('attribution');
  await expect(map).toHaveAttribute('data-base-layer', 'map');
  await expect(attribution).toContainText('OpenStreetMap');

  await page.getByTestId('draw-button').click();
  await clickMap(page, 0.4, 0.4);
  await clickMap(page, 0.6, 0.42);
  await clickMap(page, 0.52, 0.62);
  await expect(page.getByTestId('point-count')).toHaveAttribute('data-count', '3');
  const km2 = await liveKm2(page);
  expect(km2).toBeGreaterThan(0);
  const start = await centre(page);
  const placedOnMap = await drawnPoints(page);

  await page.getByTestId('layer-switch-aerial').click();
  await expect(map).toHaveAttribute('data-base-layer', 'govmap-itm');
  await expect(attribution).toHaveAttribute('data-base-layer', 'govmap-itm');
  await expect(attribution).toContainText('GovMap');
  await expect(page.getByTestId('point-count')).toHaveAttribute('data-count', '3');
  await expect(page.getByTestId('options-bar')).toHaveAttribute('data-content', 'drawing');
  expect(Math.abs((await liveKm2(page)) - km2) / km2).toBeLessThanOrEqual(1e-9);
  expect(offset(await centre(page), start)).toBeLessThanOrEqual(1e-6);
  expect(largestMove(await drawnPoints(page), placedOnMap)).toBeLessThanOrEqual(SAME_PLACE_DEG);

  // A point placed on Aerial, left of the closing edge, so the ring stays simple.
  await clickMap(page, 0.3, 0.55);
  await expect(page.getByTestId('point-count')).toHaveAttribute('data-count', '4');
  const km2WithAerialPoint = await liveKm2(page);
  expect(km2WithAerialPoint).toBeGreaterThan(km2);
  const placedOnAerial = await drawnPoints(page);

  // `L` on the focused map toggles back to Map.
  await map.focus();
  await page.keyboard.press('l');
  await expect(map).toHaveAttribute('data-base-layer', 'map');
  await expect(attribution).toContainText('OpenStreetMap');
  await expect(page.getByTestId('point-count')).toHaveAttribute('data-count', '4');
  expect(Math.abs((await liveKm2(page)) - km2WithAerialPoint) / km2WithAerialPoint).toBeLessThanOrEqual(1e-9);
  expect(offset(await centre(page), start)).toBeLessThanOrEqual(1e-6);
  expect(largestMove(await drawnPoints(page), placedOnAerial)).toBeLessThanOrEqual(SAME_PLACE_DEG);

  await page.getByTestId('cancel-draw-button').click();
  expect(errors).toEqual([]);
  await context.close();
});
