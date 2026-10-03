/**
 * Viewport -> area loading (SPEC section 8.6 "Bbox loading", section 7.12 step 4). `planViewportRequests()` is the pure request
 * planner (pad 25 %, clamp the pixel span to the server cap, clamp latitude, normalise longitude, split at +/-180);
 * `ViewportSync` runs it on `moveend` (debounced), sends `viewport.set`, loads each part as a region through
 * `AreasSync`, and reports the load state for the notices (UX C-17).
 */
import type { Bbox } from '@snapland/shared';
import { LIMITS, tileXFraction, tileXToLng, tileYToLat } from '@snapland/shared';

import { BOUNDS_DEBOUNCE_MS, PROGRESS_DELAY_MS } from '../constants/ux';
import type { Scheduler } from '../lib/scheduler';
import { Timer } from '../lib/scheduler';
import type { AreasStoreApi } from '../state/areasStore';
import { currentAreasState, isCovered } from '../state/areasStore';
import type { AreasSync, RegionLoadResult } from '../state/areasSync';

export interface PixelSize {
  x: number;
  y: number;
}

const TILE_PX = 256;
/** A 1-px margin keeps the round trip px -> degrees -> px safely under the server's span cap. */
const SPAN_SAFETY_PX = 1;
const PAD_FRACTION = 0.25;
const DEG = Math.PI / 180;
/** Leaflet can report latitudes up to (not including) +/-90° at low zoom; stay finite. */
const MAX_FINITE_LATITUDE = 89.999999;

function latToWorldY(lat: number, worldPx: number): number {
  const phi = Math.max(-MAX_FINITE_LATITUDE, Math.min(MAX_FINITE_LATITUDE, lat)) * DEG;
  return ((1 - Math.log(Math.tan(phi) + 1 / Math.cos(phi)) / Math.PI) / 2) * worldPx;
}

function clampLat(lat: number): number {
  return Math.max(-LIMITS.maxLatitude, Math.min(LIMITS.maxLatitude, lat));
}

/**
 * Plans the bbox requests for a Leaflet viewport (`getBounds()` at the integer zoom), SPEC section 8.6 steps 1-4:
 * 1. pad by 25 % of the container on each side (1.5 x the container, in pixel space) and clamp the padded pixel span to
 *    `maxSpanPx` around the centre;
 * 2. clamp latitude to +/-85.05112878;
 * 3. shift longitudes by k-360° so the centre lies in [−180, 180);
 * 4. a span >= 360° becomes one world request; a span across +/-180 becomes two requests.
 */
export function planViewportRequests(
  bounds: Bbox,
  sizePx: PixelSize,
  zoom: number,
  maxSpanPx: number = LIMITS.bboxMaxSpanPx,
): Bbox[] {
  const n = 2 ** zoom;
  const worldPx = TILE_PX * n;
  const [west, south, east, north] = bounds;
  const centreX = ((tileXFraction(west, n) + tileXFraction(east, n)) / 2) * TILE_PX;
  const centreY = (latToWorldY(north, worldPx) + latToWorldY(south, worldPx)) / 2;
  const cap = maxSpanPx - SPAN_SAFETY_PX;
  const halfWidth = Math.min(sizePx.x * (0.5 + PAD_FRACTION), cap / 2);
  const halfHeight = Math.min(sizePx.y * (0.5 + PAD_FRACTION), cap / 2);

  let padWest = tileXToLng((centreX - halfWidth) / TILE_PX, n);
  let padEast = tileXToLng((centreX + halfWidth) / TILE_PX, n);
  const padNorth = clampLat(tileYToLat(Math.max(0, centreY - halfHeight) / TILE_PX, n));
  const padSouth = clampLat(tileYToLat(Math.min(worldPx, centreY + halfHeight) / TILE_PX, n));

  const centreLng = (padWest + padEast) / 2;
  const shift = -Math.floor((centreLng + 180) / 360) * 360;
  padWest += shift;
  padEast += shift;

  if (padEast - padWest >= 360) return [[-180, padSouth, 180, padNorth]];
  if (padWest < -180) {
    return [
      [padWest + 360, padSouth, 180, padNorth],
      [-180, padSouth, padEast, padNorth],
    ];
  }
  if (padEast > 180) {
    return [
      [padWest, padSouth, 180, padNorth],
      [-180, padSouth, padEast - 360, padNorth],
    ];
  }
  return [[padWest, padSouth, padEast, padNorth]];
}

/**
 * The `viewport.set` interest bbox (SPEC section 7.4): the visible viewport, clamped and normalised; a viewport across the
 * antimeridian declares the full longitude band (the server expands interest by 50 % anyway).
 */
export function interestBbox(bounds: Bbox): Bbox {
  const [west, south, east, north] = bounds;
  const centre = (west + east) / 2;
  const shift = -Math.floor((centre + 180) / 360) * 360;
  const w = west + shift;
  const e = east + shift;
  const s = clampLat(south);
  const nn = clampLat(north);
  if (e - w >= 360 || w < -180 || e > 180) return [-180, s, 180, nn];
  return [w, s, e, nn];
}

export interface ViewportSnapshot {
  /** Raw `map.getBounds()` (longitudes may be continuous beyond +/-180). */
  bounds: Bbox;
  sizePx: PixelSize;
  /** Integer map zoom (Web Mercator). */
  zoom: number;
  centre: { lng: number; lat: number };
}

export type LoadFailure =
  { kind: 'error' } | { kind: 'rate-limited'; retryAt: number } | { kind: 'storage'; retryAt: number };

export interface MapLoadState {
  /** True once the whole paginated load has taken longer than PROGRESS_DELAY_MS (UX-AC-05). */
  showProgress: boolean;
  loading: boolean;
  failure: LoadFailure | null;
  /** Items loaded when page 10 still had a `nextCursor` (truncation notice), else null. */
  truncatedShown: number | null;
  /** Sum of the first pages' `culledCount` (culling notice), 0 when none. */
  culledCount: number;
  zoom: number | null;
}

export interface RegionLoadPerf {
  pages: number;
  items: number;
  bytes: number;
  culledCount: number | null;
  fetchMs: number;
  renderMs: number;
}

export type FailureClass =
  { kind: 'aborted' } | { kind: 'error' } | { kind: 'rate-limited' | 'storage'; retryAfterMs: number };

export interface ViewportSyncDeps {
  sync: AreasSync;
  store: AreasStoreApi;
  scheduler: Scheduler;
  sendViewport(bbox: Bbox, zoom: number): void;
  onLoadState(state: MapLoadState): void;
  onPerf(perf: RegionLoadPerf): void;
  classifyError(error: unknown): FailureClass;
  maxSpanPx(): number;
}

const IDLE_STATE: MapLoadState = {
  showProgress: false,
  loading: false,
  failure: null,
  truncatedShown: null,
  culledCount: 0,
  zoom: null,
};

export class ViewportSync {
  private latest: ViewportSnapshot | null = null;
  private controller: AbortController | null = null;
  private state: MapLoadState = IDLE_STATE;
  private readonly debounce: Timer;
  private readonly progressTimer: Timer;
  private readonly retryTimer: Timer;

  constructor(private readonly deps: ViewportSyncDeps) {
    this.debounce = new Timer(deps.scheduler, () => {
      void this.load();
    });
    this.progressTimer = new Timer(deps.scheduler, () => {
      if (this.state.loading) this.setState({ ...this.state, showProgress: true });
    });
    this.retryTimer = new Timer(deps.scheduler, () => {
      void this.load();
    });
  }

  /** The current viewport parts (for the 410 reload and eviction). */
  current(): { parts: Bbox[]; zoom: number; centre: { lng: number; lat: number } } | null {
    const snapshot = this.latest;
    if (snapshot === null) return null;
    return {
      parts: planViewportRequests(snapshot.bounds, snapshot.sizePx, snapshot.zoom, this.deps.maxSpanPx()),
      zoom: snapshot.zoom,
      centre: snapshot.centre,
    };
  }

  /** `moveend`: debounced by BOUNDS_DEBOUNCE_MS (UX F-02 step 8). */
  onMoveEnd(snapshot: ViewportSnapshot): void {
    this.latest = snapshot;
    this.deps.sendViewport(interestBbox(snapshot.bounds), snapshot.zoom);
    this.debounce.arm(BOUNDS_DEBOUNCE_MS);
  }

  /** *Retry* on the load-error notice, or a manual refresh. */
  retry(): void {
    this.retryTimer.cancel();
    void this.load(true);
  }

  dispose(): void {
    this.controller?.abort();
    this.debounce.cancel();
    this.progressTimer.cancel();
    this.retryTimer.cancel();
  }

  private setState(state: MapLoadState): void {
    this.state = state;
    this.deps.onLoadState(state);
  }

  /** Loads every part not already covered by a fetched region; newer viewports abort older loads. */
  private async load(force = false): Promise<void> {
    const snapshot = this.latest;
    if (snapshot === null) return;
    this.controller?.abort();
    const controller = new AbortController();
    this.controller = controller;
    const parts = planViewportRequests(
      snapshot.bounds,
      snapshot.sizePx,
      snapshot.zoom,
      this.deps.maxSpanPx(),
    );
    const pending = parts.filter(
      (part) => force || !isCovered(currentAreasState(this.deps.store), part, snapshot.zoom),
    );
    if (pending.length === 0) {
      this.settleCovered(snapshot.zoom);
      return;
    }
    this.retryTimer.cancel();
    this.setState({ ...this.state, loading: true, showProgress: false, failure: null, zoom: snapshot.zoom });
    this.progressTimer.arm(PROGRESS_DELAY_MS);
    try {
      const results = await Promise.all(
        pending.map((part) => this.deps.sync.loadRegion(part, snapshot.zoom, controller.signal)),
      );
      if (controller !== this.controller) return;
      if (results.some((result) => result.needsReload))
        await this.deps.sync.reloadViewport(controller.signal);
      this.finish(results);
    } catch (error) {
      if (controller !== this.controller) return;
      this.fail(error);
    }
  }

  /**
   * The whole view is already loaded. A load for a view the user has left may have been aborted just above (pan away
   * and back before it finished): end its loading state and progress bar, and drop a failure or pending automatic
   * retry that belonged to that view - nothing is missing here, so no notice about missing data may stay up.
   */
  private settleCovered(zoom: number): void {
    const settled = !this.state.loading && this.state.failure === null && this.state.zoom === zoom;
    if (settled) return;
    this.progressTimer.cancel();
    this.retryTimer.cancel();
    this.setState({ ...this.state, loading: false, showProgress: false, failure: null, zoom });
  }

  private finish(results: RegionLoadResult[]): void {
    this.progressTimer.cancel();
    const truncated = results.some((result) => result.truncated);
    const items = results.reduce((sum, result) => sum + result.items, 0);
    this.setState({
      ...this.state,
      loading: false,
      showProgress: false,
      failure: null,
      truncatedShown: truncated ? items : null,
      culledCount: results.reduce((sum, result) => sum + (result.culledCount ?? 0), 0),
    });
    const perf = results.reduce<RegionLoadPerf>(
      (sum, result) => ({
        pages: sum.pages + result.pages,
        items: sum.items + result.items,
        bytes: sum.bytes + result.bytes,
        culledCount: (sum.culledCount ?? 0) + (result.culledCount ?? 0),
        fetchMs: Math.max(sum.fetchMs, result.fetchMs),
        renderMs: 0,
      }),
      { pages: 0, items: 0, bytes: 0, culledCount: null, fetchMs: 0, renderMs: 0 },
    );
    this.deps.onPerf(perf);
  }

  private fail(error: unknown): void {
    this.progressTimer.cancel();
    const failure = this.deps.classifyError(error);
    if (failure.kind === 'aborted') return;
    if (failure.kind === 'error') {
      this.setState({ ...this.state, loading: false, showProgress: false, failure: { kind: 'error' } });
      return;
    }
    // 429 / 503 on a read: keep what is shown and retry automatically, with no Retry button (UX F-12 step 6).
    const retryAt = this.deps.scheduler.now() + failure.retryAfterMs;
    this.setState({
      ...this.state,
      loading: false,
      showProgress: false,
      failure: { kind: failure.kind, retryAt },
    });
    this.retryTimer.arm(failure.retryAfterMs);
  }
}
