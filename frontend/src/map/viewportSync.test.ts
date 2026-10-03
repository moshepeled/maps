import type { Bbox } from '@snapland/shared';
import { LIMITS, bboxSpanPx, tileXFraction, tileXToLng, tileYFraction, tileYToLat } from '@snapland/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { systemScheduler } from '../lib/scheduler';
import { beginRegion, completeRegion, createAreasStore } from '../state/areasStore';
import type { AreasSync, RegionLoadResult } from '../state/areasSync';
import type { MapLoadState, ViewportSnapshot } from './viewportSync';
import { ViewportSync, interestBbox, planViewportRequests } from './viewportSync';

/** Leaflet-like bounds of a container of `size` px centred on (lng, lat) at `zoom`. */
function boundsAround(lng: number, lat: number, zoom: number, size: { x: number; y: number }): Bbox {
  const n = 2 ** zoom;
  const cx = tileXFraction(lng, n) * 256;
  const cy = tileYFraction(lat, n) * 256;
  return [
    tileXToLng((cx - size.x / 2) / 256, n),
    tileYToLat((cy + size.y / 2) / 256, n),
    tileXToLng((cx + size.x / 2) / 256, n),
    tileYToLat((cy - size.y / 2) / 256, n),
  ];
}

function widthPx(bbox: Bbox, zoom: number): number {
  const n = 2 ** zoom;
  return (tileXFraction(bbox[2], n) - tileXFraction(bbox[0], n)) * 256;
}

function heightPx(bbox: Bbox, zoom: number): number {
  const n = 2 ** zoom;
  return (tileYFraction(bbox[1], n) - tileYFraction(bbox[3], n)) * 256;
}

describe('planViewportRequests (SPEC section 8.6 steps 1-4)', () => {
  it('pads the viewport by 25 % of its width and height on each side (1.5 x the container)', () => {
    const size = { x: 1000, y: 600 };
    const [request, ...rest] = planViewportRequests(boundsAround(34.78, 32.08, 14, size), size, 14);
    expect(rest).toHaveLength(0);
    expect(request).toBeDefined();
    if (request === undefined) return;
    expect(widthPx(request, 14)).toBeCloseTo(1500, 3);
    expect(heightPx(request, 14)).toBeCloseTo(900, 3);
    expect((request[0] + request[2]) / 2).toBeCloseTo(34.78, 9);
  });

  it('clamps the padded pixel span to 8,192 px so the server span cap is never hit', () => {
    const size = { x: 6000, y: 1000 };
    const [request] = planViewportRequests(boundsAround(34.78, 32.08, 17, size), size, 17);
    expect(request).toBeDefined();
    if (request === undefined) return;
    expect(widthPx(request, 17)).toBeLessThanOrEqual(LIMITS.bboxMaxSpanPx);
    expect(widthPx(request, 17)).toBeGreaterThan(LIMITS.bboxMaxSpanPx - 2);
    expect(bboxSpanPx(request, 17)).toBeLessThanOrEqual(LIMITS.bboxMaxSpanPx);
    const [custom] = planViewportRequests(boundsAround(34.78, 32.08, 17, size), size, 17, 4096);
    expect(custom !== undefined && widthPx(custom, 17)).toBeLessThanOrEqual(4096);
  });

  it('clamps latitude at minZoom 3 (Leaflet reports latitudes beyond the Web-Mercator limit)', () => {
    const size = { x: 1200, y: 1600 };
    const requests = planViewportRequests([0, -89.5, 50, 89.5], size, 3);
    for (const [, south, , north] of requests) {
      expect(north).toBeLessThanOrEqual(LIMITS.maxLatitude);
      expect(south).toBeGreaterThanOrEqual(-LIMITS.maxLatitude);
      expect(south).toBeLessThan(north);
    }
  });

  it('normalises longitudes after panning across +/-180 (continuous Leaflet longitudes)', () => {
    const size = { x: 400, y: 400 };
    const wrapped = boundsAround(34.78, 32.08, 10, size).map((value, index) =>
      index % 2 === 0 ? value + 360 : value,
    ) as Bbox;
    const [request] = planViewportRequests(wrapped, size, 10);
    const [direct] = planViewportRequests(boundsAround(34.78, 32.08, 10, size), size, 10);
    expect(request?.[0]).toBeCloseTo(direct?.[0] ?? 0, 9);
    expect(request?.[2]).toBeCloseTo(direct?.[2] ?? 0, 9);
  });

  it('splits a viewport across the antimeridian into two requests', () => {
    const size = { x: 455, y: 300 };
    const requests = planViewportRequests(boundsAround(180, 5, 5, size), size, 5);
    expect(requests).toHaveLength(2);
    const [east, west] = requests;
    expect(east?.[2]).toBe(180);
    expect(west?.[0]).toBe(-180);
    expect(east?.[0]).toBeGreaterThan(160);
    expect(west?.[2]).toBeLessThan(-160);
    for (const part of requests) expect(part[0]).toBeLessThan(part[2]);
    // The mirror case: the viewport centred just east of −180.
    const mirrored = planViewportRequests(boundsAround(-179.5, 5, 5, size), size, 5);
    expect(mirrored).toHaveLength(2);
    expect(mirrored.some((part) => part[2] === 180)).toBe(true);
  });

  it('a span of 360° or more becomes one world request', () => {
    const size = { x: 1920, y: 900 };
    const requests = planViewportRequests(boundsAround(20, 10, 3, size), size, 3);
    expect(requests).toHaveLength(1);
    expect(requests[0]?.[0]).toBe(-180);
    expect(requests[0]?.[2]).toBe(180);
  });

  it('interestBbox normalises and declares the full band across the antimeridian', () => {
    expect(interestBbox([34.7, 32.0, 34.9, 32.2])).toEqual([34.7, 32.0, 34.9, 32.2]);
    expect(interestBbox([394.7, 32.0, 394.9, 32.2])[0]).toBeCloseTo(34.7, 9);
    expect(interestBbox([170, 0, 190, 89])).toEqual([-180, 0, 180, LIMITS.maxLatitude]);
  });
});

function result(partial: Partial<RegionLoadResult> = {}): RegionLoadResult {
  return {
    pages: 1,
    items: 3,
    bytes: 100,
    culledCount: 0,
    truncated: false,
    fetchMs: 5,
    needsReload: false,
    ...partial,
  };
}

describe('ViewportSync (moveend -> debounced region loads -> load state)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  function setup(loadRegion: AreasSync['loadRegion'], store = createAreasStore()) {
    const states: MapLoadState[] = [];
    const viewports: { bbox: Bbox; zoom: number }[] = [];
    const reloadViewport = vi.fn(() => Promise.resolve());
    const sync = { loadRegion, reloadViewport } as unknown as AreasSync;
    const viewportSync = new ViewportSync({
      sync,
      store,
      scheduler: systemScheduler,
      sendViewport: (bbox, zoom) => viewports.push({ bbox, zoom }),
      onLoadState: (state) => states.push(state),
      onPerf: () => undefined,
      classifyError: (error) =>
        error instanceof Error && error.message === '429'
          ? { kind: 'rate-limited', retryAfterMs: 5000 }
          : { kind: 'error' },
      maxSpanPx: () => LIMITS.bboxMaxSpanPx,
    });
    return { viewportSync, states, viewports, reloadViewport };
  }

  const snapshot: ViewportSnapshot = {
    bounds: [34.7, 32.0, 34.9, 32.2],
    sizePx: { x: 1000, y: 800 },
    zoom: 12,
    centre: { lng: 34.8, lat: 32.1 },
  };

  it('sends viewport.set at once, loads after 250 ms and reports truncation and culling', async () => {
    const loadRegion = vi.fn(() =>
      Promise.resolve(result({ truncated: true, items: 20_000, culledCount: 2300 })),
    );
    const { viewportSync, states, viewports } = setup(loadRegion);
    viewportSync.onMoveEnd(snapshot);
    expect(viewports).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(249);
    expect(loadRegion).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(loadRegion).toHaveBeenCalledTimes(1);
    const last = states.at(-1);
    expect(last?.truncatedShown).toBe(20_000);
    expect(last?.culledCount).toBe(2300);
    expect(last?.loading).toBe(false);
    expect(viewportSync.current()?.parts).toHaveLength(1);
  });

  it('shows progress only when the whole load takes longer than 400 ms', async () => {
    let resolve: (value: RegionLoadResult) => void = () => undefined;
    const loadRegion = vi.fn(() => new Promise<RegionLoadResult>((done) => (resolve = done)));
    const { viewportSync, states } = setup(loadRegion);
    viewportSync.onMoveEnd(snapshot);
    await vi.advanceTimersByTimeAsync(250 + 399);
    expect(states.some((state) => state.showProgress)).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(states.at(-1)?.showProgress).toBe(true);
    resolve(result());
    await vi.advanceTimersByTimeAsync(0);
    expect(states.at(-1)?.showProgress).toBe(false);
  });

  it('a 429 keeps the areas and retries automatically after the countdown; other errors wait for Retry', async () => {
    const loadRegion = vi
      .fn<AreasSync['loadRegion']>()
      .mockRejectedValueOnce(new Error('429'))
      .mockResolvedValue(result());
    const { viewportSync, states } = setup(loadRegion);
    viewportSync.onMoveEnd(snapshot);
    await vi.advanceTimersByTimeAsync(250);
    expect(states.at(-1)?.failure?.kind).toBe('rate-limited');
    await vi.advanceTimersByTimeAsync(5000);
    expect(loadRegion).toHaveBeenCalledTimes(2);
    expect(states.at(-1)?.failure).toBeNull();

    loadRegion.mockRejectedValueOnce(new Error('boom'));
    viewportSync.retry();
    await vi.advanceTimersByTimeAsync(0);
    expect(states.at(-1)?.failure?.kind).toBe('error');
    await vi.advanceTimersByTimeAsync(60_000);
    expect(loadRegion).toHaveBeenCalledTimes(3);
    viewportSync.dispose();
  });

  it('returning to an already-loaded view clears a failure that belonged to the view I left (QA-T5-04)', async () => {
    const store = createAreasStore();
    store
      .getState()
      .update((state) =>
        completeRegion(beginRegion(state, { id: 1, bbox: [30, 28, 40, 36], zoom: 12 }), 1, 1),
      );
    const loadRegion = vi.fn<AreasSync['loadRegion']>().mockRejectedValue(new Error('429'));
    const { viewportSync, states } = setup(loadRegion, store);
    viewportSync.onMoveEnd({ ...snapshot, bounds: [2.2, 48.8, 2.4, 49.0], centre: { lng: 2.3, lat: 48.9 } });
    await vi.advanceTimersByTimeAsync(250);
    expect(states.at(-1)?.failure?.kind).toBe('rate-limited');
    viewportSync.onMoveEnd(snapshot); // covered by the fetched region
    await vi.advanceTimersByTimeAsync(250);
    expect(states.at(-1)?.failure).toBeNull();
    expect(states.at(-1)?.loading).toBe(false);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(loadRegion).toHaveBeenCalledTimes(1);
    viewportSync.dispose();
  });

  it('a catch-up overflow triggers the viewport reload', async () => {
    const loadRegion = vi.fn(() => Promise.resolve(result({ needsReload: true })));
    const { viewportSync, reloadViewport } = setup(loadRegion);
    viewportSync.onMoveEnd(snapshot);
    await vi.advanceTimersByTimeAsync(250);
    expect(reloadViewport).toHaveBeenCalledTimes(1);
  });
});
