/**
 * Shared E2E helpers (SPEC section 12.2): users and areas made through the public REST API, signed-in browser contexts on a
 * chosen view, and Web-Mercator pixel maths for placing areas at a known place on screen.
 *
 * The specs only assert on the DOM contract (UX section 12 test ids and data attributes), so they run against any build of
 * the stack: the E2E build (docker-compose.e2e.yml) or a production build such as an isolated review stack
 * (`E2E_BASE_URL=http://localhost:5185`). Every run makes its own users and areas, far from anyone else's data.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import type {
  Browser,
  BrowserContext,
  BrowserContextOptions,
  Locator,
  Page,
  WebSocket,
} from '@playwright/test';
import { devices, expect } from '@playwright/test';

export const BASE_URL = process.env['E2E_BASE_URL'] ?? 'http://localhost:5173';

/** The project's test password: `E2E_PASSWORD`, else `SEED_USER_PASSWORD` from `.env.example` (never a real secret). */
export function testPassword(): string {
  const fromEnv = process.env['E2E_PASSWORD'];
  if (fromEnv !== undefined && fromEnv !== '') return fromEnv;
  const example = readFileSync(fileURLToPath(new URL('../../.env.example', import.meta.url)), 'utf8');
  const password = /^SEED_USER_PASSWORD=(.*)$/mu.exec(example)?.[1]?.trim();
  if (password === undefined || password === '')
    throw new Error('SEED_USER_PASSWORD is missing from .env.example');
  return password;
}

const PASSWORD = testPassword();

export interface TestUser {
  id: string;
  username: string;
  displayName: string;
  token: string;
}

/** A short run-unique suffix, so repeated runs never collide on usernames or area names. */
export function stamp(): string {
  return `${Date.now().toString(36)}${Math.floor(Math.random() * 1296).toString(36)}`;
}

/**
 * A random spot in the Negev and the Arava, far from the seeded and reviewed areas. The range is wide (~ 100 x 70 km)
 * so that earlier runs' areas are rarely in a new run's view; specs still pick their own areas by name.
 */
export function quietPlace(): { lat: number; lng: number } {
  return { lat: 30.0 + Math.random() * 0.9, lng: 34.6 + Math.random() * 0.7 };
}

async function post(path: string, body: unknown, token?: string): Promise<{ status: number; json: unknown }> {
  const response = await fetch(`${BASE_URL}/api/v1${path}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      origin: BASE_URL,
      ...(token === undefined ? {} : { authorization: `Bearer ${token}` }),
    },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  return { status: response.status, json: text === '' ? null : (JSON.parse(text) as unknown) };
}

/** Registers a fresh user through the API. */
export async function newUser(prefix: string, displayName: string): Promise<TestUser> {
  const username = `e2e-${prefix}-${stamp()}`.slice(0, 32);
  const { status, json } = await post('/auth/register', { username, password: PASSWORD, displayName });
  if (status !== 201) throw new Error(`register ${username}: ${String(status)} ${JSON.stringify(json)}`);
  const body = json as { user: { id: string; displayName: string }; accessToken: string };
  return { id: body.user.id, username, displayName: body.user.displayName, token: body.accessToken };
}

export type Ring = [number, number][];

/** A closed rectangle ring [lng, lat] from its south-west corner and size in degrees. */
export function rectangle(west: number, south: number, width: number, height: number): Ring {
  return [
    [west, south],
    [west + width, south],
    [west + width, south + height],
    [west, south + height],
    [west, south],
  ];
}

/** Creates an area through the API as `user`; returns its id. */
export async function createArea(user: TestUser, name: string, ring: Ring): Promise<string> {
  const { status, json } = await post(
    '/areas',
    { name, geometry: { type: 'Polygon', coordinates: [ring] } },
    user.token,
  );
  if (status !== 201) throw new Error(`create ${name}: ${String(status)} ${JSON.stringify(json)}`);
  const body = json as { area?: { id: string }; id?: string };
  const id = body.area?.id ?? body.id;
  if (id === undefined) throw new Error(`create ${name}: no id in ${JSON.stringify(json)}`);
  return id;
}

export interface SessionOptions {
  viewport?: { width: number; height: number };
  center: { lat: number; lng: number };
  zoom: number;
  choice?: 'map' | 'aerial';
  touch?: boolean;
  theme?: 'dark' | 'light';
  colorScheme?: 'light' | 'dark';
  /** Close every `/ws` socket at once (the realtime channel is down; REST still works). */
  blockWebSocket?: boolean;
}

/** The fields of a server WebSocket message read here: `welcome.instanceId`, and a `batch`'s messages. */
interface ServerFrame {
  type?: string;
  data?: { instanceId?: string; messages?: ServerFrame[] };
}

export interface Session {
  context: BrowserContext;
  page: Page;
  /** Uncaught page errors seen so far. */
  errors: string[];
  /** The backend replica of the open WebSocket (its `welcome.instanceId`), or null while none is open. */
  instanceId: () => string | null;
}

/**
 * A new browser context for `user`, with its stored view (centre, zoom, base map) set before any script runs, signed
 * in through the real sign-in form, and waiting until the live channel is up (unless the WebSocket is blocked).
 */
export async function openSession(
  browser: Browser,
  user: TestUser,
  options: SessionOptions,
): Promise<Session> {
  const viewport = options.viewport ?? { width: 1440, height: 900 };
  const contextOptions: BrowserContextOptions =
    options.touch === true
      ? { ...devices['Pixel 5'], viewport, hasTouch: true, isMobile: true }
      : { viewport };
  const context = await browser.newContext({ ...contextOptions, colorScheme: options.colorScheme ?? 'dark' });
  await context.addInitScript(
    ({ id, view, theme }) => {
      try {
        if (sessionStorage.getItem('e2e-init') !== null) return;
        sessionStorage.setItem('e2e-init', '1');
        localStorage.setItem(`snapland:view:${id}`, JSON.stringify(view));
        if (theme !== null) localStorage.setItem('snapland.theme', theme);
      } catch {
        // Storage may be unavailable; the app then starts at its default view.
      }
    },
    {
      id: user.id,
      view: { center: options.center, zoom: options.zoom, choice: options.choice ?? 'map' },
      theme: options.theme ?? null,
    },
  );
  if (options.blockWebSocket === true) {
    await context.routeWebSocket(/\/ws/u, (socket) => socket.close({ code: 1011, reason: 'blocked' }));
  }
  const page = await context.newPage();
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(`pageerror: ${error.message}`));
  let welcomed: { socket: WebSocket; instanceId: string } | null = null;
  page.on('websocket', (socket) => {
    socket.on('framereceived', ({ payload }) => {
      if (typeof payload !== 'string') return;
      // The server sends `welcome` on its own or inside a `batch` (SPEC section 7.5).
      const message = JSON.parse(payload) as ServerFrame;
      const messages = message.type === 'batch' ? (message.data?.messages ?? []) : [message];
      const instanceId = messages.find((item) => item.type === 'welcome')?.data?.instanceId;
      if (instanceId !== undefined) welcomed = { socket, instanceId };
    });
    socket.on('close', () => {
      if (welcomed?.socket === socket) welcomed = null;
    });
  });
  await page.goto(`${BASE_URL}/signin`);
  await page.getByTestId('username-input').fill(user.username);
  await page.getByTestId('password-input').fill(PASSWORD);
  await page.getByTestId('signin-submit').click();
  await expect(page.getByTestId('map')).toBeVisible({ timeout: 15_000 });
  if (options.blockWebSocket !== true) {
    await expect(page.getByTestId('connection-status')).toHaveAttribute('data-state', 'live', {
      timeout: 15_000,
    });
  }
  return { context, page, errors, instanceId: () => welcomed?.instanceId ?? null };
}

export interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

export async function boxOf(locator: Locator): Promise<Box> {
  const box = await locator.boundingBox();
  if (box === null) throw new Error('element has no box (not visible)');
  return box;
}

export function intersects(a: Box, b: Box): boolean {
  return a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
}

/** Clicks the map at fractions of its box (0..1). */
export async function clickMap(page: Page, fx: number, fy: number): Promise<void> {
  const map = await boxOf(page.getByTestId('map'));
  await page.mouse.click(map.x + map.width * fx, map.y + map.height * fy);
}

// -- Web Mercator (256 px tiles), for placing areas at a known spot on screen ------------------

function worldSize(zoom: number): number {
  return 256 * 2 ** zoom;
}

export function lngToX(lng: number, zoom: number): number {
  return ((lng + 180) / 360) * worldSize(zoom);
}

export function latToY(lat: number, zoom: number): number {
  const sin = Math.sin((lat * Math.PI) / 180);
  return (0.5 - Math.log((1 + sin) / (1 - sin)) / (4 * Math.PI)) * worldSize(zoom);
}

export function yToLat(y: number, zoom: number): number {
  const n = Math.PI - (2 * Math.PI * y) / worldSize(zoom);
  return (180 / Math.PI) * Math.atan(Math.sinh(n));
}

export function xToLng(x: number, zoom: number): number {
  return (x / worldSize(zoom)) * 360 - 180;
}
