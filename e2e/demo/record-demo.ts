/**
 * Records scenes 2-11 of the demo video (docs/demo/STORYBOARD.md): Dana and Omer use Snapland at the same time, each in
 * a browser context of 960 x 1080 with its own video. Writes `recording/dana.webm`, `recording/omer.webm` and
 * `recording/timeline.json` (when each scene starts); compose-demo.ts turns them into docs/demo/snapland-demo.mp4.
 *
 * Not a test: it runs against a fresh isolated stack (docs/demo/README.md), because it signs up fixed users. It waits
 * on UI state before every beat that depends on it; the fixed pauses are the storyboard's pacing.
 */
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

import type { Browser, BrowserContext, Locator, Page, WebSocketRoute } from '@playwright/test';
import { expect, test } from '@playwright/test';

import { testPassword } from '../support/session.js';

const BASE_URL = process.env['DEMO_BASE_URL'] ?? 'http://localhost:5192';
const OUT = fileURLToPath(new URL('./recording/', import.meta.url));
const VIEWPORT = { width: 960, height: 1080 };
const PASSWORD = testPassword();

// -- Places (STORYBOARD section 3): lat, lng; an edit handle's data-index is the vertex's index in the drawn order ----------
type LatLng = readonly [number, number];
interface Point {
  x: number;
  y: number;
}
const START_VIEW = { center: { lat: 32.0729, lng: 34.7885 }, zoom: 17, choice: 'map' };
/**
 * STORYBOARD section 3's vertices, started from the SE corner instead of the NW one: the same counter-clockwise ring, but every
 * partial outline is a simple polygon, so the live readout never shows "Closing edge would cross" while Dana draws.
 */
const SARONA = [
  [32.07152, 34.78843], // 0 SE corner
  [32.07322, 34.78848], // 1 NE corner
  [32.07328, 34.78488], // 2 NW corner
  [32.07284, 34.78488], // 3 West
  [32.07281, 34.78609], // 4 Inner corner
  [32.07152, 34.78609], // 5 South notch
] as const satisfies readonly LatLng[];
const SARONA_INSIDE: LatLng = [32.0725, 34.787];
const V2_SE: LatLng = [32.07098, 34.78843];
const V2_NEW_POINT: LatLng = [32.071, 34.7864];
const V3_NE: LatLng = [32.07322, 34.78935];
const V4_INNER: LatLng = [32.07215, 34.7853];
const EMPTY_SPOT: LatLng = [32.0742, 34.786];
const AZRIELI = [
  [32.07556, 34.79168],
  [32.07446, 34.79116],
  [32.07382, 34.79132],
  [32.07393, 34.79239],
  [32.07429, 34.79262],
  [32.07556, 34.79224],
] as const satisfies readonly LatLng[];
const POPUP = [
  [32.0702, 34.7852],
  [32.0696, 34.7852],
  [32.0696, 34.7866],
  [32.0702, 34.7866],
] as const satisfies readonly LatLng[];
const POPUP_INSIDE: LatLng = [32.0699, 34.7859];

const CAPTIONS: Record<number, string> = {
  2: 'Dana signs up with her email, Omer with a username. Both land on the same live map.',
  3: 'Dana outlines Sarona Park. The area updates as she draws; Omer sees her draft live.',
  4: 'Dana saves it. Omer sees the same area, measured on the curved Earth, not a flat map.',
  5: 'Omer switches to the GovMap aerial photo mid-drawing. His points stay on the same spot.',
  6: 'Dana reshapes the park. Midpoint handles slide with the drag; Omer watches it live.',
  7: 'Both edit at once. Dana saves first, so Omer gets a clear choice and nothing is lost.',
  8: 'Every save is a version. Dana previews v3 and restores it as a new version, v5.',
  9: 'Delete is soft and undoable. Omer sees the area go and come back.',
  10: 'Dark or light: the theme is a choice per browser. Omer stays dark.',
  11: 'Omer’s live link drops. The app falls back to polling, keeps saving, then catches up.',
};

// -- Page-side helpers (serialised into each page by addInitScript) -------------------------------------------------

interface LeafletMap {
  getContainer(): HTMLElement;
  latLngToContainerPoint(latLng: [number, number]): { x: number; y: number };
}

declare global {
  interface Window {
    /** The screen point of `lat, lng` on the live map (installMapProbe), or null before the map exists. */
    demoMapPoint?: (lat: number, lng: number) => { x: number; y: number } | null;
  }
}

/** Playwright videos have no OS cursor: a drawn pointer with a press effect (STORYBOARD section 6.3). */
function installPointer(): void {
  addEventListener('DOMContentLoaded', () => {
    const dot = document.createElement('div');
    Object.assign(dot.style, {
      position: 'fixed',
      left: '-40px',
      top: '-40px',
      width: '18px',
      height: '18px',
      margin: '-9px 0 0 -9px',
      borderRadius: '50%',
      border: '2px solid #fff',
      background: 'rgb(0 0 0 / 0.35)',
      boxShadow: '0 0 0 1px rgb(0 0 0 / 0.6)',
      pointerEvents: 'none',
      zIndex: '2147483647',
      transition: 'transform 120ms',
    });
    document.body.append(dot);
    const onMove = (event: PointerEvent): void => {
      dot.style.left = `${String(event.clientX)}px`;
      dot.style.top = `${String(event.clientY)}px`;
    };
    addEventListener('pointermove', onMove, true);
    addEventListener('pointerdown', () => (dot.style.transform = 'scale(0.6)'), true);
    addEventListener('pointerup', () => (dot.style.transform = ''), true);
  });
}

/**
 * The production build has no E2E hook, so the recorder finds screen points through Leaflet itself: its bundle assigns
 * `window.L`, and this setter registers every map as it is created. Read-only: the app never sees the difference.
 */
function installMapProbe(): void {
  const maps: LeafletMap[] = [];
  let leaflet: unknown;
  Object.defineProperty(window, 'L', {
    configurable: true,
    get: () => leaflet,
    set: (value: { Map: { addInitHook(hook: (this: LeafletMap) => void): void } }) => {
      leaflet = value;
      value.Map.addInitHook(function (this: LeafletMap) {
        maps.push(this);
      });
    },
  });
  window.demoMapPoint = (lat, lng) => {
    // The newest map still on the page: a base-map switch to Aerial replaces the Mercator map with an ITM one.
    const map = maps.filter((candidate) => candidate.getContainer().isConnected).at(-1);
    if (map === undefined) return null;
    const point = map.latLngToContainerPoint([lat, lng]);
    const box = map.getContainer().getBoundingClientRect();
    return { x: box.left + point.x, y: box.top + point.y };
  };
}

// -- Panes and pacing -----------------------------------------------------------------------------------------------

interface Pane {
  name: 'Dana' | 'Omer';
  context: BrowserContext;
  page: Page;
  /** Date.now() when the page (and its video) started. */
  startedAt: number;
  /** The user's colour from the register response, for the caption band. */
  color: string;
  pointer: Point;
  /** The live channel, routed through Playwright so a scene can cut it on cue (scene 11 cuts Omer's). */
  socket: { blocked: boolean; live: { page: WebSocketRoute; server: WebSocketRoute } | null };
}

async function openPane(browser: Browser, name: Pane['name']): Promise<Pane> {
  const context = await browser.newContext({
    baseURL: BASE_URL,
    viewport: VIEWPORT,
    colorScheme: 'dark',
    reducedMotion: 'no-preference',
    recordVideo: { dir: OUT, size: VIEWPORT },
  });
  // Actions fail like expects do, instead of waiting for the 10 min take timeout.
  context.setDefaultTimeout(20_000);
  await context.addInitScript(installPointer);
  await context.addInitScript(installMapProbe);
  const socket: Pane['socket'] = { blocked: false, live: null };
  // Before the first page: WebSocket routing is installed into each new document (STORYBOARD section 6.5). `unrouteAll()`
  // does not remove a WebSocket route, so the handler reads a flag.
  await context.routeWebSocket(/\/ws/u, async (ws) => {
    if (socket.blocked) {
      await ws.close({ code: 1001, reason: 'demo: network drop' });
      return;
    }
    socket.live = { page: ws, server: ws.connectToServer() };
  });
  const page = await context.newPage();
  const pane: Pane = {
    name,
    context,
    page,
    startedAt: Date.now(),
    color: '',
    pointer: { x: 480, y: 760 },
    socket,
  };
  // The stored view is keyed by user id, which exists only after sign-up: store it before the app reads it (section 6.2).
  await page.route('**/api/v1/auth/register', async (route) => {
    const response = await route.fetch();
    const { user } = (await response.json()) as { user: { id: string; color: string } };
    pane.color = user.color;
    await page.evaluate(
      ([key, value]) => {
        localStorage.setItem(key, value);
      },
      [`snapland:view:${user.id}`, JSON.stringify(START_VIEW)] as const,
    );
    await route.fulfill({ response });
  });
  await page.goto('/signin');
  await expect(page.getByTestId('signin-submit')).toBeVisible();
  return pane;
}

/** Pacing: resolves `seconds` after `start` (at once when that moment has passed). */
async function until(start: number, seconds: number): Promise<void> {
  const wait = start + seconds * 1000 - Date.now();
  if (wait > 0) await sleep(wait);
}

/** Moves the mouse from `from` to `to` in `ms`, however long each move takes (a busy page answers moves slowly). */
async function moveOver(
  pane: Pane,
  from: Point,
  to: Point,
  ms: number,
  ease: (t: number) => number,
): Promise<void> {
  const started = Date.now();
  let t = 0;
  while (t < 1) {
    await sleep(20);
    t = Math.min(1, (Date.now() - started) / ms);
    const k = ease(t);
    await pane.page.mouse.move(from.x + (to.x - from.x) * k, from.y + (to.y - from.y) * k);
  }
  pane.pointer = to;
}

/** Glides the pointer to `to` along an eased path, so the viewer (and the other user) can follow it. */
async function glide(pane: Pane, to: Point, ms = 650): Promise<void> {
  if (Math.hypot(to.x - pane.pointer.x, to.y - pane.pointer.y) < 1) return;
  await moveOver(pane, pane.pointer, to, ms, (t) => (t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2));
}

async function clickPoint(pane: Pane, point: Point): Promise<void> {
  await glide(pane, point);
  await sleep(300);
  await pane.page.mouse.down();
  await sleep(90);
  await pane.page.mouse.up();
}

/** The centre of `target` once it is visible, stable (not animating) and not covered: the trial click checks all three. */
async function centreOf(target: Locator): Promise<Point> {
  await target.click({ trial: true });
  const box = await target.boundingBox();
  if (box === null) throw new Error(`${target.toString()} has no box`);
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
}

async function click(pane: Pane, target: Locator): Promise<void> {
  await glide(pane, await centreOf(target));
  // Aim again before pressing: a card that was still sliding in when it was measured has moved since.
  await clickPoint(pane, await centreOf(target));
}

/** The screen point of a coordinate, read right before use: the map pans on its own (STORYBOARD section 6.4). */
async function mapPoint(pane: Pane, [lat, lng]: LatLng): Promise<Point> {
  const point = await pane.page.evaluate(([la, ln]) => window.demoMapPoint?.(la, ln) ?? null, [
    lat,
    lng,
  ] as const);
  if (point === null) throw new Error(`${pane.name}: no map to place ${String(lat)}, ${String(lng)}`);
  return point;
}

async function clickMap(pane: Pane, latLng: LatLng): Promise<void> {
  await clickPoint(pane, await mapPoint(pane, latLng));
}

/** A visible drag: press, move at an even pace for `ms`, release (Playwright's `steps` alone would jump). */
async function drag(pane: Pane, from: Point, to: Point, ms: number): Promise<void> {
  await glide(pane, from);
  await sleep(300);
  await pane.page.mouse.down();
  await moveOver(pane, from, to, ms, (t) => t);
  await pane.page.mouse.up();
}

async function type(pane: Pane, field: Locator, text: string, delay = 70): Promise<void> {
  await click(pane, field);
  await field.pressSequentially(text, { delay });
}

function handle(pane: Pane, testId: 'point-handle' | 'midpoint-handle', index: number): Locator {
  return pane.page.locator(`[data-testid="${testId}"][data-index="${String(index)}"]`);
}

function toast(pane: Pane, text: string): Locator {
  return pane.page.getByTestId('toast').filter({ hasText: text });
}

// -- The take -------------------------------------------------------------------------------------------------------

interface SceneMark {
  n: number;
  caption: string;
  at: number;
}

/** Plays scenes 2-11 on both panes; `marks` receives each scene's start. Returns when the last scene ends. */
async function playScenes(dana: Pane, omer: Pane, marks: SceneMark[]): Promise<number> {
  const scene = (n: number): number => {
    const at = Date.now();
    marks.push({ n, caption: CAPTIONS[n] ?? '', at });
    return at;
  };

  // -- Scene 2: sign up, the Studio frame, presence --
  let start = scene(2);
  const signUp = async (pane: Pane, offset: number, username: string, displayName: string): Promise<void> => {
    const { page } = pane;
    await until(start, offset);
    await click(pane, page.getByRole('link', { name: 'New to Snapland? Create an account' }));
    await type(pane, page.getByTestId('username-input'), username);
    await type(pane, page.getByTestId('display-name-input'), displayName);
    await type(pane, page.getByTestId('password-input'), PASSWORD, 40);
    await click(pane, page.getByTestId('signup-submit'));
    await expect(page.getByTestId('connection-status')).toHaveAttribute('data-state', 'live');
  };
  await Promise.all([
    (async () => {
      await signUp(dana, 0.8, 'dana@example.com', 'Dana');
      await expect(dana.page.getByTestId('presence-button')).toContainText('2 online');
      await until(start, 9.5);
      await glide(dana, { x: 24, y: 200 }, 500);
      await glide(dana, await centreOf(dana.page.getByTestId('draw-button')), 900);
    })(),
    (async () => {
      await signUp(omer, 3.8, 'omer.levi', 'Omer');
      await until(start, 11);
      await click(omer, omer.page.getByTestId('people-button'));
      await expect(omer.page.getByTestId('presence-list')).toContainText('Dana');
    })(),
  ]);
  if (dana.color === omer.color)
    throw new Error(`Both users got the colour "${dana.color}": throw this take away (section 3)`);
  await until(start, 15.5);

  // -- Scene 3: Dana draws, Omer sees the live draft --
  start = scene(3);
  await until(start, 0.5);
  await click(dana, dana.page.getByTestId('draw-button'));
  for (const [index, vertex] of SARONA.entries()) {
    await until(start, 1.5 + index * 1.3);
    await clickMap(dana, vertex);
  }
  await expect(dana.page.getByTestId('point-count')).toHaveAttribute('data-count', '6');
  await until(start, 9.5);
  await glide(dana, await mapPoint(dana, SARONA[0]), 900);
  await expect(omer.page.getByTestId('remote-draft-chip')).toBeVisible();
  await until(start, 12.5);

  // -- Scene 4: save; the same km² on both screens --
  start = scene(4);
  await clickMap(dana, SARONA[0]);
  const nameField = dana.page.getByTestId('area-name-input');
  await expect(nameField).toBeFocused();
  await until(start, 0.6);
  await nameField.pressSequentially('Sarona Park', { delay: 70 });
  await until(start, 2.2);
  await click(dana, dana.page.getByTestId('save-area-submit'));
  await expect(toast(dana, 'Saved “Sarona Park”')).toBeVisible();
  await expect(toast(omer, 'Dana created “Sarona Park”')).toBeVisible();
  await until(start, 6.5);
  await glide(omer, await mapPoint(omer, SARONA_INSIDE), 900);
  await until(start, 9.5);
  await Promise.all([
    click(dana, dana.page.getByTestId('close-panel-button')),
    click(omer, omer.page.getByTestId('inspector-close')),
  ]);
  await until(start, 10.5);

  // -- Scene 5: Omer switches Map -> Aerial mid-drawing --
  start = scene(5);
  await click(omer, omer.page.getByTestId('draw-button'));
  for (const [index, vertex] of AZRIELI.slice(0, 3).entries()) {
    await until(start, 1 + index * 1.2);
    await clickMap(omer, vertex);
  }
  await until(start, 4.5);
  // To the base-map control by way of the options bar, leaving the map north-east of the three points: a provisional
  // point just west of them would make the draft's edges cross, and the bar would flash "Closing edge would cross".
  const bar = await omer.page.getByTestId('options-bar').boundingBox();
  if (bar === null) throw new Error('Omer has no options bar');
  await glide(omer, { x: (await mapPoint(omer, [32.0762, 34.7925])).x, y: bar.y + bar.height / 2 });
  const aerial = omer.page.getByTestId('layer-switch-aerial');
  await click(omer, aerial);
  await expect(omer.page.getByTestId('map')).toHaveAttribute('data-base-layer', 'govmap-itm');
  await expect(omer.page.locator('.leaflet-container')).toHaveCount(1);
  await expect(omer.page.getByTestId('point-count')).toHaveAttribute('data-count', '3');
  await until(start, 6.5);
  // East of the three points, so the rubber band never crosses the draft.
  await glide(omer, await mapPoint(omer, [32.0752, 34.7936]), 900);
  await glide(omer, await mapPoint(omer, [32.0741, 34.7931]), 900);
  for (const [index, vertex] of AZRIELI.slice(3).entries()) {
    await until(start, 9 + index * 1.2);
    await clickMap(omer, vertex);
  }
  await until(start, 12.6);
  await clickMap(omer, AZRIELI[0]);
  const omerName = omer.page.getByTestId('area-name-input');
  await expect(omerName).toBeFocused();
  await until(start, 13.4);
  await omerName.pressSequentially('Azrieli Center', { delay: 70 });
  await until(start, 15);
  await click(omer, omer.page.getByTestId('save-area-submit'));
  await expect(toast(omer, 'Saved “Azrieli Center”')).toBeVisible();
  await until(start, 17);
  await click(omer, omer.page.getByTestId('close-panel-button'));
  await until(start, 17.8);
  // Drag the map so the start view's centre returns to the middle (the save form had panned it left).
  const mapBox = await omer.page.getByTestId('map').boundingBox();
  if (mapBox === null) throw new Error('Omer has no map');
  const mapCentre = { x: mapBox.x + mapBox.width / 2, y: mapBox.y + mapBox.height / 2 };
  const home = await mapPoint(omer, [START_VIEW.center.lat, START_VIEW.center.lng]);
  const shift = { x: mapCentre.x - home.x, y: mapCentre.y - home.y };
  await drag(
    omer,
    { x: mapCentre.x - shift.x / 2, y: mapCentre.y + 200 - shift.y / 2 },
    { x: mapCentre.x + shift.x / 2, y: mapCentre.y + 200 + shift.y / 2 },
    1000,
  );
  await expect(toast(dana, 'Omer created “Azrieli Center”')).toBeVisible();
  await until(start, 20);

  // -- Scene 6: Dana reshapes the park; midpoints follow the drag --
  start = scene(6);
  await clickMap(dana, SARONA_INSIDE);
  await expect(dana.page.getByTestId('area-panel-name')).toHaveText('Sarona Park');
  await until(start, 1.2);
  await click(dana, dana.page.getByTestId('edit-shape-button'));
  await expect(handle(dana, 'point-handle', 0)).toBeVisible();
  await until(start, 2.4);
  await drag(dana, await centreOf(handle(dana, 'point-handle', 0)), await mapPoint(dana, V2_SE), 1500);
  await until(start, 4.8);
  await drag(
    dana,
    await centreOf(handle(dana, 'midpoint-handle', 5)),
    await mapPoint(dana, V2_NEW_POINT),
    1000,
  );
  await expect(dana.page.getByTestId('point-handle')).toHaveCount(7);
  await until(start, 8);
  await click(dana, dana.page.getByTestId('save-edit-button'));
  await expect(toast(dana, 'Saved changes to “Sarona Park” · v2')).toBeVisible();
  await until(start, 12.5);

  // -- Scene 7: both edit at once; the second save gets a clear choice --
  start = scene(7);
  await Promise.all([
    (async () => {
      await click(dana, dana.page.getByTestId('edit-shape-button'));
      await until(start, 6);
      await drag(dana, await centreOf(handle(dana, 'point-handle', 1)), await mapPoint(dana, V3_NE), 1200);
      await until(start, 9);
      await click(dana, dana.page.getByTestId('save-edit-button'));
      await expect(toast(dana, 'Saved changes to “Sarona Park” · v3')).toBeVisible();
    })(),
    (async () => {
      await until(start, 1.5);
      await clickMap(omer, SARONA_INSIDE);
      await expect(omer.page.getByTestId('lock-banner')).toBeVisible();
      await until(start, 4);
      await click(omer, omer.page.getByTestId('edit-shape-button'));
      await until(start, 6.5);
      await drag(omer, await centreOf(handle(omer, 'point-handle', 4)), await mapPoint(omer, V4_INNER), 1200);
      await until(start, 8.2);
      await clickMap(omer, EMPTY_SPOT);
    })(),
  ]);
  await expect(omer.page.getByTestId('options-bar')).toContainText('Dana saved a newer version.');
  await until(start, 12);
  await click(omer, omer.page.getByTestId('save-edit-button'));
  await expect(omer.page.getByTestId('conflict-panel')).toBeVisible();
  const showTheirs = omer.page.getByRole('button', { name: 'Show theirs' });
  await until(start, 14);
  await click(omer, showTheirs);
  await until(start, 16.5);
  await click(omer, showTheirs);
  await until(start, 17.5);
  await click(omer, omer.page.getByTestId('conflict-keep-mine'));
  await expect(toast(omer, 'Saved changes to “Sarona Park” · v4')).toBeVisible();
  await expect(toast(dana, 'Omer reshaped “Sarona Park”')).toBeVisible();
  await until(start, 24);

  // -- Scene 8: version history and restore --
  start = scene(8);
  await glide(dana, await centreOf(dana.page.getByTestId('history-section')), 900);
  await until(start, 1.5);
  await click(dana, dana.page.locator('[data-testid="history-item"][data-version="3"]'));
  await expect(dana.page.getByTestId('history-preview-banner')).toBeVisible();
  await until(start, 5);
  await click(dana, dana.page.getByTestId('restore-version-button'));
  await expect(toast(dana, 'Restored v3 of “Sarona Park” as v5')).toBeVisible();
  await expect(toast(omer, 'Dana reshaped “Sarona Park”')).toBeVisible();
  await until(start, 13);

  // -- Scene 9: delete with Undo --
  start = scene(9);
  await click(dana, dana.page.getByTestId('delete-area-button'));
  const deleted = toast(dana, 'Deleted “Sarona Park”');
  await expect(deleted).toBeVisible();
  await expect(omer.page.getByTestId('deleted-state')).toBeVisible();
  await until(start, 4.5);
  await click(dana, deleted.getByTestId('toast-undo'));
  await expect(toast(dana, '“Sarona Park” is back')).toBeVisible();
  await expect(toast(omer, 'Dana restored “Sarona Park”')).toBeVisible();
  await until(start, 11);

  // -- Scene 10: the light theme, per browser --
  start = scene(10);
  await click(dana, dana.page.getByTestId('user-menu-button'));
  await until(start, 1.2);
  await click(dana, dana.page.getByTestId('theme-option-light'));
  await until(start, 3.5);
  await Promise.all([
    (async () => {
      await click(dana, dana.page.getByTestId('user-menu-button'));
      await click(dana, dana.page.getByTestId('close-panel-button'));
    })(),
    click(omer, omer.page.getByTestId('close-panel-button')),
  ]);
  await until(start, 6);

  // -- Scene 11: Omer's live connection drops; limited mode; reconnect and catch up --
  start = scene(11);
  omer.socket.blocked = true;
  await omer.socket.live?.page.close({ code: 1001, reason: 'demo: network drop' });
  await omer.socket.live?.server.close();
  const omerSummary = omer.page.getByTestId('analysis-summary').first();
  const areasBefore = Number(await omerSummary.getAttribute('data-count'));
  await Promise.all([
    (async () => {
      await until(start, 0.5);
      await click(dana, dana.page.getByTestId('draw-button'));
      for (const [index, vertex] of POPUP.slice(0, 3).entries()) {
        await until(start, 1.2 + index * 1.2);
        await clickMap(dana, vertex);
      }
      // A double-click places the last point and finishes, so Dana saves before Omer's first poll (10 s after the drop)
      // and the poll brings the area at once, instead of 5 s later.
      const last = await mapPoint(dana, POPUP[3]);
      await glide(dana, last);
      await sleep(300);
      await dana.page.mouse.dblclick(last.x, last.y);
      await expect(dana.page.getByTestId('area-name-input')).toBeFocused();
      await dana.page.getByTestId('area-name-input').pressSequentially('Pop-up Market', { delay: 70 });
      await click(dana, dana.page.getByTestId('save-area-submit'));
      await expect(toast(dana, 'Saved “Pop-up Market”')).toBeVisible();
    })(),
    (async () => {
      const pill = omer.page.getByTestId('connection-status');
      await expect(pill).toHaveAttribute('data-state', 'reconnecting');
      await expect(pill).toHaveAttribute('data-state', 'limited');
      await expect(omerSummary).toHaveAttribute('data-count', String(areasBefore + 1));
      await until(start, 12);
      await clickMap(omer, POPUP_INSIDE);
      await expect(omer.page.getByTestId('area-panel-name')).toHaveText('Pop-up Market');
      await until(start, 13.5);
      await click(omer, omer.page.getByTestId('rename-button'));
      const rename = omer.page.getByTestId('rename-input');
      await rename.press('Control+A');
      await rename.pressSequentially('Friday Market', { delay: 70 });
      await rename.press('Enter');
      await expect(toast(omer, 'Renamed to “Friday Market”')).toBeVisible();
    })(),
  ]);
  await expect(dana.page.getByTestId('area-panel-name')).toHaveText('Friday Market');
  await until(start, 18);
  await click(omer, omer.page.getByTestId('connection-status'));
  await until(start, 19.5);
  omer.socket.blocked = false;
  await until(start, 20);
  await click(omer, omer.page.getByRole('button', { name: 'Reconnect now' }));
  await expect(omer.page.getByTestId('connection-status')).toHaveAttribute('data-state', 'live');
  await expect(toast(omer, 'You’re back online. 1 area in view changed while you were away.')).toBeVisible();
  await expect(dana.page.getByTestId('presence-button')).toContainText('2 online');
  await until(start, 26);
  return Date.now();
}

test('record the Snapland demo', async ({ browser }) => {
  rmSync(OUT, { recursive: true, force: true });
  mkdirSync(OUT, { recursive: true });
  const dana = await openPane(browser, 'Dana');
  const omer = await openPane(browser, 'Omer');
  const marks: SceneMark[] = [];
  const end = await playScenes(dana, omer, marks).finally(async () => {
    // Closing the contexts finishes the videos, also after a failed take (they show what went wrong).
    for (const pane of [dana, omer]) {
      await pane.context.close();
      const video = pane.page.video();
      await video?.saveAs(`${OUT}${pane.name.toLowerCase()}.webm`);
      await video?.delete();
    }
  });
  const t0 = marks[0]?.at ?? end;
  const panes = [dana, omer].map((pane) => ({
    name: pane.name,
    video: `${pane.name.toLowerCase()}.webm`,
    color: pane.color,
    offsetMs: t0 - pane.startedAt,
  }));
  const scenes = marks.map((mark) => ({ n: mark.n, caption: mark.caption, startMs: mark.at - t0 }));
  writeFileSync(`${OUT}timeline.json`, `${JSON.stringify({ panes, scenes, endMs: end - t0 }, null, 2)}\n`);
});
