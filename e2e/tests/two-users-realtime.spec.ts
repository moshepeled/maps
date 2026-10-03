/**
 * Two users on one map, each on a different backend replica (R1, R7, R30, R33; UX C-07, C-08, UX-AC-50 - 52, 119):
 * Alma's live draft reaches Bento with her person chip showing her readout's area (to the drafts' 6-dp wire precision),
 * her presence turns to drawing, and her save replaces the draft with a saved area and an Activity item.
 * Bento's window is the 1024 px overlay layout with the Areas list open, so Alma's chip must also keep clear of the
 * overlay inspector (UI.md section 9.8 placement rules, Studio fix round 2).
 */
import { expect, test } from '@playwright/test';

import { boxOf, clickMap, intersects, newUser, openSession, quietPlace, stamp } from '../support/session.js';

test('R30 R33 UX-AC-119 a live draft and its chip reach the other user, clear of the overlay; the save replaces it', async ({
  browser,
}) => {
  const alma = await newUser('alma', 'Alma Levi');
  const bento = await newUser('bento', 'Bento Cohen');
  const center = quietPlace();
  const a = await openSession(browser, alma, { center, zoom: 15 });
  const b = await openSession(browser, bento, { viewport: { width: 1024, height: 768 }, center, zoom: 15 });

  // SPEC section 12.2: the two users sit on different backend replicas, so Alma's draft reaches Bento through the Redis
  // fan-out. nginx's least_conn nearly always does that; when both sockets land on one replica, Bento reconnects.
  await expect
    .poll(
      async () => {
        const replica = b.instanceId();
        if (replica === null) return 'connecting';
        if (replica !== a.instanceId()) return 'apart';
        await b.page.reload();
        return 'same replica';
      },
      { timeout: 30_000 },
    )
    .toBe('apart');
  await expect(b.page.getByTestId('connection-status')).toHaveAttribute('data-state', 'live');
  test.info().annotations.push({
    type: 'replicas',
    description: `Alma ${String(a.instanceId())}, Bento ${String(b.instanceId())}`,
  });

  // Bento opens the Areas list: the overlay inspector covers the right of his map.
  await b.page.getByTestId('areas-button').click();
  const overlay = b.page.getByTestId('inspector');
  await expect(overlay).toHaveAttribute('data-open', 'true');
  await expect(overlay).toHaveAttribute('data-layout', 'overlay');

  // Alma draws three points; her last point lands just left of Bento's overlay (both maps share the centre).
  await a.page.getByTestId('draw-button').click();
  const aMap = await boxOf(a.page.getByTestId('map'));
  const px = (dx: number, dy: number) => ({
    fx: (aMap.width / 2 + dx) / aMap.width,
    fy: (aMap.height / 2 + dy) / aMap.height,
  });
  for (const { dx, dy } of [
    { dx: -60, dy: -80 },
    { dx: 40, dy: -60 },
    { dx: 90, dy: 30 },
  ]) {
    const { fx, fy } = px(dx, dy);
    await clickMap(a.page, fx, fy);
  }
  await expect(a.page.getByTestId('point-count')).toHaveAttribute('data-count', '3');

  const chip = b.page.getByTestId('remote-draft-chip');
  await expect(b.page.getByTestId('remote-draft')).toHaveAttribute('data-user-id', alma.id, {
    timeout: 5_000,
  });
  await expect(chip).toHaveAttribute('data-user-id', alma.id);
  await expect(chip).toContainText('drawing');

  // Alma's pointer leaves the map, so her readout and the draft she streams are the three placed points.
  const aInspector = await boxOf(a.page.getByTestId('inspector'));
  await a.page.mouse.move(aInspector.x + aInspector.width / 2, aInspector.y + aInspector.height - 40);
  const readout = a.page.getByTestId('area-readout').first();
  const km2 = Number(await readout.getAttribute('data-km2'));
  expect(km2).toBeGreaterThan(0);
  // Bento's chip shows the area of Alma's readout, computed on his side from the vertices she streams. Drafts travel
  // at 6 dp and her readout uses the 7-dp points (SPEC section 7.6), so the two agree to within her perimeter x the largest
  // 6-dp shift of a vertex (8 cm): about 1e-3 of this area, far below a missing, extra or misplaced point. The chip
  // appears with her first point; the later points arrive a few frames after it.
  const tolerance = Number(await readout.getAttribute('data-perimeter-km')) * 8e-5;
  await expect
    .poll(async () => Math.abs(Number(await chip.getAttribute('data-km2')) - km2))
    .toBeLessThanOrEqual(tolerance);
  // The chip flipped or collapsed rather than hiding under the overlay inspector.
  await expect
    .poll(async () => intersects(await boxOf(chip), await boxOf(overlay)), { timeout: 3_000 })
    .toBe(false);
  expect(['left', 'disc']).toContain(await chip.getAttribute('data-placement'));

  // Presence: Alma is drawing, as Bento's People section shows.
  await b.page.getByTestId('people-toggle').click();
  await expect(b.page.locator(`[data-testid="presence-item"][data-user-id="${alma.id}"]`)).toHaveAttribute(
    'data-status',
    'drawing',
    { timeout: 5_000 },
  );

  // Alma saves: Bento's draft goes, the area arrives, and his Activity lists it. His view may already hold areas of
  // earlier runs (the Negev is shared by every run), so the summary is counted from what he had loaded by now.
  const summary = b.page.getByTestId('analysis-summary').first();
  const areasBefore = Number(await summary.getAttribute('data-count'));
  await a.page.getByTestId('finish-button').click();
  await a.page.getByTestId('area-name-input').fill(`Shared ${stamp()}`);
  await a.page.getByTestId('save-area-submit').click();
  await expect(b.page.getByTestId('remote-draft')).toHaveCount(0, { timeout: 5_000 });
  await expect(summary).toHaveAttribute('data-count', String(areasBefore + 1), { timeout: 5_000 });
  await b.page.getByTestId('activity-toggle').click();
  await expect(
    b.page.locator(`[data-testid="activity-item"][data-user-id="${alma.id}"][data-code="collab.created"]`),
  ).toHaveCount(1, { timeout: 5_000 });
  await expect(b.page.locator(`[data-testid="presence-item"][data-user-id="${alma.id}"]`)).toHaveAttribute(
    'data-status',
    'viewing',
    { timeout: 5_000 },
  );

  expect(a.errors).toEqual([]);
  expect(b.errors).toEqual([]);
  await a.context.close();
  await b.context.close();
});
