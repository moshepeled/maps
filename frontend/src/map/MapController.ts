/**
 * The imperative side of the map (SPEC section 8.4, section 8.6; UX section 3.3, section 7, C-04 ... C-08): one or more stacked Leaflet maps (a
 * cross-CRS switch keeps the outgoing map underneath until the incoming one has loaded), their base layers with the
 * load-gated cross-fade, every overlay as a view of the stores, pointer / keyboard input routed to the workspace
 * flows, and the `MapBridge` the flows use. Geometry never lives here: rebuilding a map loses nothing.
 */
import type { Bbox, Position } from '@snapland/shared';
import { EQUATOR_METERS_PER_PIXEL_Z0, expandBbox } from '@snapland/shared';
import L from 'leaflet';

import {
  DUPLICATE_POINT_PX,
  DUPLICATE_POINT_TOUCH_PX,
  LAYER_FADE_MS,
  MAP_MAX_ZOOM,
  MAP_MIN_ZOOM,
  SNAP_FIRST_POINT_PX,
  SNAP_FIRST_POINT_TOUCH_PX,
  TILE_FAIL_WINDOW_MS,
  TOAST_INFO_MS,
  TOOLTIP_DELAY_MS,
} from '../constants/ux';
import { base } from '../base/en';
import { formatArea } from '../lib/format';
import type { Scheduler, TimerHandle } from '../lib/scheduler';
import { displayName } from '../lib/text';
import type { AppServices } from '../app/services';
import { deriveDrawing } from '../state/drawingReducer';
import { activeLock } from '../state/locksStore';
import type { BaseLayerId } from '../state/mapViewStore';
import { isDraftIdle } from '../state/remoteDraftsStore';
import { drawingLimits } from '../state/runtimeConfigStore';
import type { WorkspaceState } from '../state/workspaceStore';
import { allowsDoubleClickZoom } from '../state/workspaceStore';
import type { MapBridge } from '../workspace/context';
import { showToast } from '../workspace/context';
import type { Workspace } from '../workspace/Workspace';
import { AreasLayer } from './AreasLayer';
import type { BaseLayerHandle } from './baseLayers';
import { createBaseLayer } from './baseLayers';
import type { FadeLayer, FrameScheduler } from './crossfade';
import { BaseLayerCrossfade } from './crossfade';
import { CrsZoomMemory, itmLevelToMercatorZoom, mercatorZoomToItmLevel } from './crs';
import { DecorationsLayer } from './DecorationsLayer';
import { hitTest } from './hitTest';
import { insideItmCoverage, ITM_RESOLUTIONS } from './itm';
import type { CrsKind, MapInstance } from './mapInstance';
import { createMapInstance, PANES } from './mapInstance';
import type { OverlayTokens } from './overlayUtil';
import { themeController } from '../theme/theme';
import { bboxCorners, panIntoFreeArea, readMapInsets } from './mapInsets';
import type { MapInsets, ScreenBox } from './mapInsets';
import type { ChipToPlace } from './chipPlacement';
import { placeChips } from './chipPlacement';
import { fromLatLng, readOverlayTokens, toLatLng } from './overlayUtil';
import { OwnDraftLayer } from './OwnDraftLayer';
import { RemoteDraftsLayer } from './RemoteDraftsLayer';
import { groupElement, openElementTooltip, textElement } from './safe-dom';
import { VertexEditor } from './VertexEditor';
import { interestBbox } from './viewportSync';

/** The hover tooltip sits this far above the pointer and at least this far inside the visible map. */
const TOOLTIP_OFFSET_Y = -12;
/** Below the pointer, the tooltip clears the cursor's own height. */
const TOOLTIP_OFFSET_BELOW_Y = 16;
const TOOLTIP_EDGE_PX = 8;
/** Space kept around a fitted shape, on top of the insets (UI.md section 4.4). */
const FIT_PADDING_PX = 48;
/**
 * Space kept around a shape panned out from under the overlay inspector (UX section 3.2), measured from what is drawn: the
 * selection's corner brackets stand `--ov-bracket-offset` outside the shape's box, so they are added on top.
 */
const REVEAL_PADDING_PX = 16;
/** Space kept around a shape whose point handles must stay reachable: half the 44 px touch target, plus 2. */
const HANDLE_REVEAL_PADDING_PX = 24;
/** The [N] selected chip shows from this Web-Mercator zoom (UI.md section 9.8). */
const SELECTED_CHIP_MIN_ZOOM = 14;

/**
 * What floats over the map inside its box (UI.md section 9.8 rule 2): notices, the control column (phones: the control row),
 * the overlay inspector, the sheet, toasts and the attribution. Chips flip away from these.
 */
const CHIP_OBSTACLES = [
  '.notice-slot > *',
  '.map-controls',
  '[data-testid="inspector"][data-layout="overlay"][data-open="true"]',
  '[data-testid="area-sheet"]',
  '[data-testid="toast"]',
  '[data-testid="attribution"]',
].join(', ');
/** Margins that keep a keyboard-selected point clear of the notice slot, the toasts and the map edges (UX-AC-99). */
const VISIBLE_MARGIN_TOP_PX = 72;
const VISIBLE_MARGIN_BOTTOM_PX = 96;
const VISIBLE_MARGIN_SIDE_PX = 40;

export interface MapControllerDeps {
  host: HTMLElement;
  workspace: Workspace;
  services: AppServices;
  scheduler: Scheduler;
  frames: FrameScheduler;
  reducedMotion(): boolean;
  coarsePointer(): boolean;
  isPhone(): boolean;
}

interface Bundle {
  kind: CrsKind;
  instance: MapInstance;
  fade: BaseLayerCrossfade;
  layers: Map<BaseLayerId, BaseLayerHandle>;
  areas: AreasLayer;
  decorations: DecorationsLayer;
  own: OwnDraftLayer;
  remote: RemoteDraftsLayer;
  editor: VertexEditor;
  disposed: boolean;
}

/** The cross-CRS switch fades whole stacked map containers (SPEC section 8.4, same rules as a layer fade). */
class ContainerFade implements FadeLayer {
  constructor(
    readonly bundle: Bundle,
    private readonly baseLayer: () => BaseLayerHandle | null,
    private readonly onRemove: (bundle: Bundle) => void,
  ) {}

  private static z = 1;

  show(opacity: number): void {
    ContainerFade.z += 1;
    this.bundle.instance.container.style.opacity = String(opacity);
    this.bundle.instance.container.style.zIndex = String(ContainerFade.z);
  }

  setOpacity(opacity: number): void {
    this.bundle.instance.container.style.opacity = String(opacity);
  }

  bringToFront(): void {
    ContainerFade.z += 1;
    this.bundle.instance.container.style.zIndex = String(ContainerFade.z);
  }

  remove(): void {
    this.onRemove(this.bundle);
  }

  onLoad(callback: () => void): () => void {
    return this.baseLayer()?.onLoad(callback) ?? (() => undefined);
  }

  isLoaded(): boolean {
    return this.baseLayer()?.isLoaded() ?? true;
  }
}

function crsOf(layer: BaseLayerId): CrsKind {
  return layer === 'govmap-itm' ? 'itm' : 'mercator';
}

/** The bbox of a list of positions, or null for none. */
function pointsBbox(points: readonly Position[]): Bbox | null {
  if (points.length === 0) return null;
  const lngs = points.map(([lng]) => lng);
  const lats = points.map(([, lat]) => lat);
  return [Math.min(...lngs), Math.min(...lats), Math.max(...lngs), Math.max(...lats)];
}

function bboxOfBounds(bounds: L.LatLngBounds): Bbox {
  return [bounds.getWest(), bounds.getSouth(), bounds.getEast(), bounds.getNorth()];
}

type PointerKind = 'mouse' | 'touch' | 'pen';

function pointerKind(type: string): PointerKind {
  return type === 'touch' ? 'touch' : type === 'pen' ? 'pen' : 'mouse';
}

/** Chrome marks the compatibility mouse events a touch fires (`sourceCapabilities`); other browsers do not. */
function firesTouchEvents(event: Event): boolean {
  const source = (event as { sourceCapabilities?: { firesTouchEvents?: boolean } | null }).sourceCapabilities;
  return source?.firesTouchEvents === true;
}

/**
 * How far to slide a tooltip that sits centred over `anchorX` so it stays `margin` px inside a map `mapWidth` wide
 * (the same rule as the map chips, UI.md section 9.8). 0 when it already fits.
 */
export function tooltipShift(anchorX: number, width: number, mapWidth: number, margin: number): number {
  const left = anchorX - width / 2;
  const right = anchorX + width / 2;
  if (right > mapWidth - margin) return Math.max(margin - left, mapWidth - margin - right);
  if (left < margin) return margin - left;
  return 0;
}

/**
 * When the phone map must bring the shape into the free strip between the HUD (or the title bar) and the sheet (or the
 * control row), UX section 3.2 [M]: a new selection, entering Drawing or EditingShape (the HUD docks above the map without
 * moving its content, so the shape can end up under it), and coming back to the selection from those modes (the
 * sheet returns over the lower map).
 */
export function phoneRevealNeeded(
  state: Pick<WorkspaceState, 'layout' | 'mode' | 'selectedAreaId'>,
  previous: Pick<WorkspaceState, 'mode' | 'selectedAreaId'>,
): boolean {
  if (state.layout !== 'phone') return false;
  const entered = state.mode !== previous.mode;
  if (state.mode === 'editing-shape' || state.mode === 'drawing') return entered;
  if (state.mode !== 'area-selected' || state.selectedAreaId === null) return false;
  return entered || state.selectedAreaId !== previous.selectedAreaId;
}

/**
 * Whether the hover tooltip (drawn above the pointer) would rise past the top of the visible map, so it must hang
 * below the pointer instead (UI.md section 9.8 "a chip never leaves the visible map").
 */
export function tooltipFlipsBelow(
  pointerY: number,
  height: number,
  visibleTop: number,
  margin: number,
): boolean {
  return pointerY + TOOLTIP_OFFSET_Y - height < visibleTop + margin;
}

export class MapController implements MapBridge {
  private bundles: Bundle[] = [];
  private primary: Bundle;
  private readonly containerFade: BaseLayerCrossfade;
  private readonly containerFades = new Map<Bundle, ContainerFade>();
  private readonly crsMemory = new CrsZoomMemory();
  private tileEvents: { at: number; ok: boolean }[] = [];
  private readonly unsubscribers: (() => void)[] = [];
  private renderFrame: number | null = null;
  private pointerFrame: number | null = null;
  private pendingPointer: L.LatLng | null | undefined;
  private tooltip: L.Tooltip | null = null;
  private tooltipTimer: TimerHandle | null = null;
  private tooltipAreaId: string | null = null;
  private tooltipLatLng: L.LatLng | null = null;
  private pointerType: PointerKind = 'mouse';
  private lastClickRefused = false;
  private firstPointHot = false;
  private keyboardModality = false;
  private dblClickTimer: TimerHandle | null = null;
  private tokens: OverlayTokens;
  private disposed = false;
  /** A `flyToBounds` is running: `revealBbox` must not interrupt it (its padding already clears the insets). */
  private flying = false;
  /** A deferred fly (it waits one frame for the layout it has to clear) or phone reveal. */
  private flyFrame: number | null = null;
  private revealFrame: number | null = null;
  /** Each chip's full size, measured once: its content never changes (the layers rebuild a chip that changes). */
  private readonly chipSizes = new WeakMap<HTMLElement, { width: number; height: number }>();

  constructor(private readonly deps: MapControllerDeps) {
    this.tokens = this.readTokens();
    this.containerFade = new BaseLayerCrossfade({
      scheduler: deps.scheduler,
      frames: deps.frames,
      reducedMotion: () => deps.reducedMotion(),
      onMidpoint: (layer) => {
        if (layer instanceof ContainerFade) this.setPrimary(layer.bundle);
      },
    });
    const view = this.stores.mapView.getState();
    const kind = crsOf(view.baseLayer);
    const zoom = kind === 'itm' ? mercatorZoomToItmLevel(view.center.lat, view.zoom) : view.zoom;
    const bundle = this.createBundle(kind, [view.center.lat, view.center.lng], zoom);
    const containerLayer = this.containerFadeFor(bundle);
    this.containerFade.initialise(containerLayer);
    this.primary = bundle;
    this.showBaseLayer(bundle, view.baseLayer, true);
    this.bindInput();
    this.subscribe();
    this.reportView();
    this.scheduleRender();
  }

  private get stores() {
    return this.deps.services.stores;
  }

  /** The canvas and bracket tokens follow the map tone: the host's base layer and the theme (UI.md section 2.5). */
  private readTokens(): OverlayTokens {
    return readOverlayTokens(getComputedStyle(this.deps.host));
  }

  private get workspace() {
    return this.deps.workspace;
  }

  // -- bundles (one stacked map each) --------------------------------------------------------

  private createBundle(kind: CrsKind, center: L.LatLngExpression, zoom: number): Bundle {
    const instance = createMapInstance(this.deps.host, kind, center, zoom);
    const { map } = instance;
    const bundle: Bundle = {
      kind,
      instance,
      fade: new BaseLayerCrossfade({
        scheduler: this.deps.scheduler,
        frames: this.deps.frames,
        reducedMotion: () => this.deps.reducedMotion(),
        onMidpoint: (layer) => {
          if (bundle === this.primary) this.onLayerDisplayed(layer as BaseLayerHandle);
        },
      }),
      layers: new Map(),
      areas: new AreasLayer(map),
      decorations: new DecorationsLayer(map),
      own: new OwnDraftLayer(map),
      remote: new RemoteDraftsLayer(map),
      editor: new VertexEditor(map, {
        onSelect: (index) => {
          this.workspace.edit.select(index);
        },
        onDragStart: (index) => {
          this.workspace.edit.dragStart(index);
        },
        onDrag: (index, position) => {
          this.workspace.edit.drag(index, position);
        },
        onDragEnd: (index, position) => {
          this.workspace.edit.dragEnd(index, position);
        },
        onMidpointActivate: (edgeIndex, position) => {
          this.workspace.edit.insertAt(edgeIndex, position);
        },
        onDeleteRequest: (index) => {
          this.workspace.edit.deletePoint(index);
        },
      }),
      disposed: false,
    };
    this.bundles.push(bundle);
    this.bindMapEvents(bundle);
    return bundle;
  }

  private containerFadeFor(bundle: Bundle): ContainerFade {
    let fade = this.containerFades.get(bundle);
    if (fade === undefined) {
      fade = new ContainerFade(
        bundle,
        () => bundle.fade.active as BaseLayerHandle | null,
        (removed) => {
          this.disposeBundle(removed);
        },
      );
      this.containerFades.set(bundle, fade);
    }
    return fade;
  }

  private disposeBundle(bundle: Bundle): void {
    if (bundle.disposed || bundle === this.primary) return;
    bundle.disposed = true;
    bundle.fade.dispose();
    bundle.areas.dispose();
    bundle.decorations.dispose();
    bundle.own.dispose();
    bundle.remote.dispose();
    bundle.editor.dispose();
    bundle.instance.dispose();
    this.bundles = this.bundles.filter((candidate) => candidate !== bundle);
    this.containerFades.delete(bundle);
  }

  private setPrimary(bundle: Bundle): void {
    if (this.primary === bundle) return;
    this.hideTooltip();
    this.primary = bundle;
    const active = bundle.fade.active as BaseLayerHandle | null;
    if (active !== null) this.onLayerDisplayed(active);
    this.reportView();
    this.scheduleRender();
  }

  private handleFor(bundle: Bundle, id: BaseLayerId): BaseLayerHandle {
    let handle = bundle.layers.get(id);
    if (handle === undefined) {
      handle = createBaseLayer(id, bundle.instance.map, (ok) => {
        this.onTile(ok);
      });
      bundle.layers.set(id, handle);
    }
    return handle;
  }

  private showBaseLayer(bundle: Bundle, id: BaseLayerId, initial: boolean): void {
    const handle = this.handleFor(bundle, id);
    if (initial || bundle.fade.active === null) {
      bundle.fade.initialise(handle);
      if (bundle === this.primary) this.onLayerDisplayed(handle);
      return;
    }
    bundle.fade.switchTo(handle);
  }

  /** The visible base layer changed (fade midpoint): data-base-layer, overlay tokens, attribution (UI.md section 8). */
  private onLayerDisplayed(handle: BaseLayerHandle): void {
    this.stores.mapView.getState().setDisplayed(handle.id);
    this.deps.host.dataset['baseLayer'] = handle.id;
    this.tokens = this.readTokens();
    this.updateCoverage();
    this.scheduleRender();
  }

  /** Map <-> Aerial (same CRS: layer cross-fade) or to/from the ITM cache (cross-CRS: stacked maps), SPEC section 8.4. */
  private switchBaseLayer(id: BaseLayerId): void {
    const target = crsOf(id);
    if (target === this.primary.kind) {
      this.showBaseLayer(this.primary, id, false);
      return;
    }
    const from = this.primary.instance.map;
    const center = from.getCenter();
    const zoom = from.getZoom();
    let targetZoom: number;
    let clamped: boolean;
    if (target === 'itm') {
      ({ zoom: targetZoom, clamped } = this.crsMemory.toItm(center.lat, zoom));
    } else {
      ({ zoom: targetZoom, clamped } = this.crsMemory.toMercator(
        center.lat,
        zoom,
        MAP_MIN_ZOOM,
        MAP_MAX_ZOOM,
      ));
    }
    const hadFocus = this.deps.host.contains(document.activeElement);
    const bundle = this.createBundle(target, center, targetZoom);
    this.showBaseLayer(bundle, id, true);
    this.containerFade.switchTo(this.containerFadeFor(bundle));
    // The new map takes input at once; the old one stays visible underneath until the new base layer has loaded.
    this.primary = bundle;
    this.onLayerDisplayed(bundle.fade.active as BaseLayerHandle);
    this.reportView();
    this.scheduleRender();
    if (hadFocus) this.focusMap();
    if (clamped && target === 'itm') {
      showToast(this.workspace.ctx, {
        lane: 'own',
        kind: 'info',
        code: 'layer.zoomClamped',
        text: base.layer.zoomClamped,
        durationMs: TOAST_INFO_MS,
      });
    }
  }

  // -- tile failures (UX section 7) -------------------------------------------------------------

  /** > 50 % of the active layer's tiles failing within 5 s -> `tiles-failing-notice` (OSM / Esri only, UX section 7). */
  private onTile(ok: boolean): void {
    const now = this.deps.scheduler.now();
    this.tileEvents = [
      ...this.tileEvents.filter((entry) => now - entry.at < TILE_FAIL_WINDOW_MS),
      { at: now, ok },
    ];
    const errors = this.tileEvents.filter((entry) => !entry.ok).length;
    const failing = this.tileEvents.length >= 4 && errors / this.tileEvents.length > 0.5;
    const displayed = this.stores.mapView.getState().displayedBaseLayer;
    const layer = displayed === 'map' ? 'map' : 'aerial';
    const current = this.stores.notices.getState().tilesFailing;
    if (failing && current === null && displayed !== 'govmap-itm')
      this.stores.notices.getState().patch({ tilesFailing: layer });
    if (!failing && current !== null && ok) this.stores.notices.getState().patch({ tilesFailing: null });
  }

  retryTiles(): void {
    this.tileEvents = [];
    this.stores.notices.getState().patch({ tilesFailing: null });
    this.primary.instance.map.eachLayer((layer) => {
      if (layer instanceof L.TileLayer) layer.redraw();
    });
  }

  // -- view reporting (viewport sync, coordinate readout, notices) --------------------------

  private mercatorZoom(bundle: Bundle): number {
    const map = bundle.instance.map;
    if (bundle.kind === 'mercator') return Math.round(map.getZoom());
    return itmLevelToMercatorZoom(map.getCenter().lat, Math.round(map.getZoom()));
  }

  private metersPerPixel(bundle: Bundle): number {
    const map = bundle.instance.map;
    if (bundle.kind === 'itm') return ITM_RESOLUTIONS[Math.round(map.getZoom())] ?? 1;
    return (
      (EQUATOR_METERS_PER_PIXEL_Z0 * Math.cos((map.getCenter().lat * Math.PI) / 180)) / 2 ** map.getZoom()
    );
  }

  private reportView(): void {
    const bundle = this.primary;
    const map = bundle.instance.map;
    const size = map.getSize();
    if (size.x === 0 || size.y === 0) return;
    const bounds = bboxOfBounds(map.getBounds());
    const center = map.getCenter();
    const mercatorZoom = this.mercatorZoom(bundle);
    this.stores.mapView.getState().setView({
      center: { lat: center.lat, lng: L.Util.wrapNum(center.lng, [-180, 180], true) },
      zoom: map.getZoom(),
      mercatorZoom,
      viewport: interestBbox(bounds),
    });
    this.stores.mapView.getState().setMetersPerPixel(this.metersPerPixel(bundle));
    this.workspace.viewportSync.onMoveEnd({
      bounds,
      sizePx: { x: size.x, y: size.y },
      zoom: mercatorZoom,
      centre: { lng: center.lng, lat: center.lat },
    });
    if (this.stores.notices.getState().emptyDismissed)
      this.stores.notices.getState().patch({ emptyDismissed: false });
    this.updateCoverage();
    if (this.workspace.ctx.stores.workspace.getState().mode === 'drawing' && this.keyboardModality) {
      this.workspace.drawing.pointer(this.reticlePointer(center));
    }
  }

  /** The coverage notice: *Aerial* (the ITM cache) covers Israel only (UX section 7, SPEC section 8.3). */
  private updateCoverage(): void {
    const { displayedBaseLayer, center } = this.stores.mapView.getState();
    const outside = displayedBaseLayer === 'govmap-itm' && !insideItmCoverage(center.lng, center.lat);
    const notices = this.stores.notices.getState();
    if (outside !== notices.outsideCoverage) notices.patch({ outsideCoverage: outside });
  }

  // -- input ---------------------------------------------------------------------------------

  private bindInput(): void {
    const host = this.deps.host;
    const pointerDown = (event: PointerEvent): void => {
      this.pointerType = pointerKind(event.pointerType);
      this.keyboardModality = false;
      host.classList.remove('is-keyboard');
    };
    // A mouse moved after a touch (hybrid devices) must hover again without clicking first.
    const pointerMove = (event: PointerEvent): void => {
      this.pointerType = pointerKind(event.pointerType);
    };
    const keyDown = (event: KeyboardEvent): void => {
      this.keyboardModality = true;
      host.classList.add('is-keyboard');
      this.onMapKey(event);
    };
    // Leaving is detected on the host itself: when the pointer exits over an overlay canvas, Leaflet hands the DOM
    // `mouseout` to that layer and never fires the map's own `mouseout`, which left a phantom pointer behind (C-06.3).
    // Map chrome (layer switch, zoom) sits outside the host, so moving onto it counts as leaving too.
    const pointerLeave = (): void => {
      if (!this.disposed) this.onPointerLeave();
    };
    // The keyboard reticle is the drawing's provisional point only while the map has keyboard focus (C-06.9). When
    // focus leaves (a click on the layer switch, Tab into the options bar) the reticle hides, so its point must go
    // too, or the readout keeps counting a point that is no longer shown (C-06.3).
    const focusOut = (event: FocusEvent): void => {
      if (this.disposed || host.contains(event.relatedTarget as Node | null)) return;
      this.onKeyboardFocusLost();
    };
    host.addEventListener('pointerdown', pointerDown, true);
    host.addEventListener('pointermove', pointerMove, true);
    host.addEventListener('mouseleave', pointerLeave);
    host.addEventListener('keydown', keyDown);
    host.addEventListener('focusout', focusOut);
    this.unsubscribers.push(() => {
      host.removeEventListener('pointerdown', pointerDown, true);
      host.removeEventListener('pointermove', pointerMove, true);
      host.removeEventListener('mouseleave', pointerLeave);
      host.removeEventListener('keydown', keyDown);
      host.removeEventListener('focusout', focusOut);
    });
  }

  private bindMapEvents(bundle: Bundle): void {
    const { map } = bundle.instance;
    const primaryOnly =
      <E>(handler: (event: E) => void) =>
      (event: E) => {
        if (bundle === this.primary && !this.disposed) handler(event);
      };
    map.on(
      'mousemove',
      primaryOnly((event: L.LeafletMouseEvent) => {
        this.onPointerMove(event);
      }),
    );
    map.on(
      'click',
      primaryOnly((event: L.LeafletMouseEvent) => {
        this.onClick(event);
      }),
    );
    map.on(
      'dblclick',
      primaryOnly((event: L.LeafletMouseEvent) => {
        this.onDoubleClick(event);
      }),
    );
    map.on(
      'moveend',
      primaryOnly(() => {
        this.reportView();
        this.scheduleRender();
      }),
    );
    map.on(
      'zoomend',
      primaryOnly(() => {
        this.scheduleRender();
      }),
    );
  }

  private coarse(): boolean {
    return this.pointerType !== 'mouse';
  }

  /**
   * Whether my draft shows the rubber-band and closing preview: not on touch, where the placed points show closed
   * (UX C-06.4, UI.md section 9.5). Leaflet still reports the compatibility mousemove of a tap; the keyboard reticle counts.
   */
  private showsPointerPreview(): boolean {
    return this.keyboardModality || this.pointerType !== 'touch';
  }

  /**
   * Touch has no hover (C-06.3, C-08, C-27): the compatibility `mousemove` of a tap must not become a pointer, or the
   * drawing keeps a provisional point on the last tap and the tap that selects an area opens the hover tooltip.
   */
  private onPointerMove(event: L.LeafletMouseEvent): void {
    if (this.pointerType === 'touch' || firesTouchEvents(event.originalEvent)) return;
    this.pendingPointer = event.latlng;
    if (this.pointerFrame !== null) return;
    this.pointerFrame = this.deps.frames.request(() => {
      this.pointerFrame = null;
      const latlng = this.pendingPointer;
      this.pendingPointer = undefined;
      if (latlng === undefined || latlng === null) return;
      this.applyPointer(latlng);
    });
  }

  private applyPointer(latlng: L.LatLng): void {
    this.stores.mapView.getState().setPointer({ lat: latlng.lat, lng: latlng.lng });
    const mode = this.stores.workspace.getState().mode;
    if (mode === 'drawing') {
      this.updateFirstPointHot(latlng);
      this.workspace.drawing.pointer(this.drawingPointer(latlng));
      this.updateCursor();
      return;
    }
    if (mode === 'browse' || mode === 'area-selected') this.updateHover(latlng);
  }

  /**
   * Where a click would act, as the drawing's pointer: on the first point when a click there finishes the shape, on
   * the last point when a click there is ignored as a duplicate (C-06.2), else the pointer itself. The reducer shows
   * no provisional point in both snapped cases, so the HUD judges the shape a click would really leave.
   */
  private drawingPointer(latlng: L.LatLng): Position {
    const points = this.stores.drawing.getState().drawing.points;
    const first = points[0];
    const last = points.at(-1);
    if (this.firstPointHot && first !== undefined) return first;
    const duplicate = this.coarse() ? DUPLICATE_POINT_TOUCH_PX : DUPLICATE_POINT_PX;
    if (last !== undefined && this.pixelDistance(last, latlng) <= duplicate) return last;
    return fromLatLng(latlng);
  }

  /**
   * The keyboard reticle as the drawing's pointer: on the last point while the reticle is within the duplicate guard
   * of it, so a Space there is ignored and the readout does not count a provisional point on top of it (C-06.2, C-06.9).
   */
  private reticlePointer(center: L.LatLng): Position {
    const last = this.stores.drawing.getState().drawing.points.at(-1);
    if (last !== undefined && this.pixelDistance(last, center) <= DUPLICATE_POINT_PX) return last;
    return fromLatLng(center);
  }

  private onPointerLeave(): void {
    this.pendingPointer = null;
    this.stores.mapView.getState().setPointer(null);
    if (this.stores.workspace.getState().mode === 'drawing') this.workspace.drawing.pointer(null);
    this.firstPointHot = false;
    this.hideTooltip();
    this.stores.workspace.getState().patch({ hoverAreaId: null });
    this.updateCursor();
  }

  private onKeyboardFocusLost(): void {
    if (!this.keyboardModality) return;
    this.keyboardModality = false;
    this.deps.host.classList.remove('is-keyboard');
    if (this.stores.workspace.getState().mode === 'drawing') this.workspace.drawing.pointer(null);
    this.scheduleRender();
  }

  private pixelDistance(a: Position, b: L.LatLng): number {
    const map = this.primary.instance.map;
    return map.latLngToContainerPoint(toLatLng(a)).distanceTo(map.latLngToContainerPoint(b));
  }

  private updateFirstPointHot(latlng: L.LatLng): void {
    const points = this.stores.drawing.getState().drawing.points;
    const first = points[0];
    const snap = this.coarse() ? SNAP_FIRST_POINT_TOUCH_PX : SNAP_FIRST_POINT_PX;
    this.firstPointHot =
      points.length >= 3 && first !== undefined && this.pixelDistance(first, latlng) <= snap;
  }

  private updateCursor(): void {
    const host = this.deps.host;
    const mode = this.stores.workspace.getState().mode;
    const drawing = this.stores.drawing.getState().drawing;
    const view =
      mode === 'drawing'
        ? deriveDrawing(drawing, drawingLimits(this.stores.runtime.getState().config))
        : null;
    host.classList.toggle('is-snap-first', mode === 'drawing' && this.firstPointHot);
    host.classList.toggle(
      'is-not-allowed',
      view !== null && !view.pointerPlaceable && view.pointer !== null && !this.firstPointHot,
    );
  }

  private updateHover(latlng: L.LatLng): void {
    const hit = this.hitAt(latlng);
    const hoverId = hit?.id ?? null;
    const workspace = this.stores.workspace.getState();
    if (workspace.hoverAreaId !== hoverId) workspace.patch({ hoverAreaId: hoverId });
    this.deps.host.classList.toggle('is-over-area', hoverId !== null);
    if (hoverId === null) {
      this.hideTooltip();
      return;
    }
    this.tooltipLatLng = latlng;
    if (this.tooltipAreaId === hoverId) {
      this.placeTooltip();
      return;
    }
    this.hideTooltip();
    this.tooltipAreaId = hoverId;
    this.tooltipTimer = this.deps.scheduler.setTimeout(() => {
      this.showTooltip(hoverId);
    }, TOOLTIP_DELAY_MS);
  }

  private showTooltip(areaId: string): void {
    const latlng = this.tooltipLatLng;
    const area = this.stores.areas.getState().byId.get(areaId);
    if (area === undefined || latlng === null) return;
    // Name, then the area in mono (UI.md section 9.3); the text content stays "{name}, {area}".
    const element = groupElement(
      'div',
      [
        textElement('span', displayName(area.name)),
        textElement('span', ` · ${formatArea(area.areaKm2)}`, { class: 'snap-area-tooltip__value' }),
      ],
      { 'data-testid': 'area-tooltip', 'data-area-id': area.id, title: area.name, dir: 'auto' },
    );
    this.tooltip = openElementTooltip(this.primary.instance.map, latlng, element, {
      className: 'snap-area-tooltip',
      direction: 'top',
      offset: [0, TOOLTIP_OFFSET_Y],
      permanent: true,
    });
    this.placeTooltip();
  }

  /** Follows the pointer and slides inward so the tooltip never runs off the visible map (UI.md section 9.8 rule). */
  private placeTooltip(): void {
    const tooltip = this.tooltip;
    const latlng = this.tooltipLatLng;
    if (tooltip === null || latlng === null) return;
    const map = this.primary.instance.map;
    tooltip.options.direction = 'top';
    tooltip.options.offset = L.point(0, TOOLTIP_OFFSET_Y);
    tooltip.setLatLng(latlng);
    const element = tooltip.getElement();
    if (element === undefined) return;
    const insets = this.insets();
    const point = map.latLngToContainerPoint(latlng);
    const visibleWidth = map.getSize().x - insets.right;
    const shift = tooltipShift(
      point.x - insets.left,
      element.offsetWidth,
      visibleWidth - insets.left,
      TOOLTIP_EDGE_PX,
    );
    // Near the top of the map the tooltip hangs below the pointer instead of rising under the options bar.
    const below = tooltipFlipsBelow(point.y, element.offsetHeight, insets.top, TOOLTIP_EDGE_PX);
    if (shift === 0 && !below) return;
    if (below) tooltip.options.direction = 'bottom';
    tooltip.options.offset = L.point(shift, below ? TOOLTIP_OFFSET_BELOW_Y : TOOLTIP_OFFSET_Y);
    tooltip.update();
  }

  private hideTooltip(): void {
    this.deps.scheduler.clearTimeout(this.tooltipTimer);
    this.tooltipTimer = null;
    this.tooltipAreaId = null;
    this.tooltip?.remove();
    this.tooltip = null;
  }

  private hitAt(latlng: L.LatLng) {
    const point: Position = [L.Util.wrapNum(latlng.lng, [-180, 180], true), latlng.lat];
    const hidden = this.stores.effects.getState().hidden;
    const areas = [...this.stores.areas.getState().byId.values()].filter((area) => !hidden.has(area.id));
    return hitTest(areas, point);
  }

  private onClick(event: L.LeafletMouseEvent): void {
    const mode = this.stores.workspace.getState().mode;
    const latlng = event.latlng;
    if (mode === 'drawing') {
      this.onDrawingClick(latlng);
      return;
    }
    if (mode === 'editing-shape') {
      const edit = this.stores.edit.getState().edit;
      if (edit?.moveArmed === true) this.workspace.edit.moveSelectedTo(fromLatLng(latlng));
      else if (edit?.selected !== null) this.workspace.edit.select(null);
      return;
    }
    if (mode === 'browse' || mode === 'area-selected') {
      this.hideTooltip();
      const hit = this.hitAt(latlng);
      if (hit !== null) this.workspace.area.select(hit.id, 'map');
      else if (mode === 'area-selected') this.workspace.area.close();
    }
  }

  /** Point placement with the duplicate guard and snap-to-first (UX C-06.2). */
  private onDrawingClick(latlng: L.LatLng): void {
    const points = this.stores.drawing.getState().drawing.points;
    const first = points[0];
    const last = points.at(-1);
    const coarse = this.coarse();
    const snap = coarse ? SNAP_FIRST_POINT_TOUCH_PX : SNAP_FIRST_POINT_PX;
    if (points.length >= 3 && first !== undefined && this.pixelDistance(first, latlng) <= snap) {
      this.lastClickRefused = false;
      this.workspace.drawing.finish();
      return;
    }
    const duplicate = coarse ? DUPLICATE_POINT_TOUCH_PX : DUPLICATE_POINT_PX;
    if (last !== undefined && this.pixelDistance(last, latlng) <= duplicate) {
      this.lastClickRefused = false;
      return;
    }
    const result = this.workspace.drawing.place(fromLatLng(latlng));
    this.lastClickRefused = result === 'refused';
  }

  /**
   * The mouse double-click finish (UX C-06.6 guard): never for Leaflet's simulated double-tap, never for touch/pen,
   * and never when its first click was refused.
   */
  private onDoubleClick(event: L.LeafletMouseEvent): void {
    if (this.stores.workspace.getState().mode !== 'drawing') return;
    const original = event.originalEvent as MouseEvent & {
      _simulated?: boolean;
      sourceCapabilities?: { firesTouchEvents?: boolean };
    };
    if (original._simulated === true) return;
    if (this.pointerType !== 'mouse') return;
    if (original.sourceCapabilities?.firesTouchEvents === true) return;
    if (this.lastClickRefused) return;
    this.workspace.drawing.finish();
  }

  private onMapKey(event: KeyboardEvent): void {
    const command = this.workspace.handleMapKey(event);
    if (command === null) return;
    event.preventDefault();
    event.stopPropagation();
    const map = this.primary.instance.map;
    switch (command.type) {
      case 'pan':
        // Instant on purpose: an animated pan is cut short by the next key press, and a Space during it would place
        // the point at a centre the map only passed through (UX C-06.9).
        map.panBy([command.dx, command.dy], { animate: false });
        return;
      case 'zoom':
        this.zoomBy(command.delta);
        return;
      case 'place':
        // Space has the same duplicate guard as a click (C-06.9): at the last point it places nothing.
        this.workspace.drawing.place(this.reticlePointer(map.getCenter()));
        return;
      case 'finish':
        this.workspace.drawing.finish();
        return;
      case 'undo':
        this.workspace.drawing.undo();
        return;
      case 'cycle':
        this.workspace.edit.cycle(command.direction);
        return;
      case 'nudge':
        this.workspace.edit.nudge(command.dx, command.dy);
        return;
      case 'delete-point':
        this.workspace.edit.deleteSelected();
        return;
      case 'insert-point':
        this.workspace.edit.insertAfterSelected();
        return;
      case 'save-edit':
        this.workspace.edit.save(true);
        return;
    }
  }

  // -- store subscriptions and rendering ----------------------------------------------------

  private subscribe(): void {
    const stores = this.stores;
    const render = (): void => {
      this.scheduleRender();
    };
    this.unsubscribers.push(
      stores.areas.subscribe(render),
      stores.drawing.subscribe(render),
      stores.edit.subscribe(render),
      stores.remoteDrafts.subscribe(render),
      stores.locks.subscribe(render),
      stores.effects.subscribe(render),
      this.workspace.ctx.clock.subscribe(render),
      stores.workspace.subscribe((state, previous) => {
        if (state.mode !== previous.mode) this.onModeChange();
        if (phoneRevealNeeded(state, previous)) this.schedulePhoneReveal();
        render();
      }),
      // Toasts and notices float over the map: chips re-place around them (UI.md section 9.8 rule 2).
      stores.toasts.subscribe(render),
      stores.notices.subscribe(render),
      stores.mapView.subscribe((state, previous) => {
        if (state.baseLayer !== previous.baseLayer) this.switchBaseLayer(state.baseLayer);
      }),
      // The OSM map tone depends on the theme (UI.md section 2.5, section 13): the canvas cannot read CSS, so re-read its colours.
      themeController().store.subscribe(() => {
        this.tokens = this.readTokens();
        render();
      }),
    );
    this.onModeChange();
  }

  /** Double-click zoom only in Browse / AreaSelected, re-enabled 400 ms after entering them (UX section 3.4). */
  private onModeChange(): void {
    const workspace = this.stores.workspace.getState();
    const mode = workspace.mode;
    this.deps.scheduler.clearTimeout(this.dblClickTimer);
    this.hideTooltip();
    for (const bundle of this.bundles) {
      const { map } = bundle.instance;
      map.doubleClickZoom.disable();
      if (mode === 'browse') map.boxZoom.enable();
      else map.boxZoom.disable();
    }
    if (mode !== 'drawing') this.firstPointHot = false;
    this.updateCursor();
    if (!allowsDoubleClickZoom(mode)) return;
    const delay = Math.max(0, workspace.dblClickZoomAfter - this.deps.scheduler.now());
    this.dblClickTimer = this.deps.scheduler.setTimeout(() => {
      if (!allowsDoubleClickZoom(this.stores.workspace.getState().mode)) return;
      for (const bundle of this.bundles) bundle.instance.map.doubleClickZoom.enable();
    }, delay);
  }

  private scheduleRender(): void {
    if (this.renderFrame !== null || this.disposed) return;
    this.renderFrame = this.deps.frames.request(() => {
      this.renderFrame = null;
      this.render();
    });
  }

  private render(): void {
    if (this.disposed) return;
    const started = performance.now();
    // *Move point* armed: the next map click moves the selected point (UI.md section 9.6 cursor).
    this.deps.host.classList.toggle('is-move-armed', this.stores.edit.getState().edit?.moveArmed === true);
    for (const bundle of this.bundles) this.renderBundle(bundle);
    this.layoutChips();
    const region = this.workspace.lastRegionLoad;
    if (region !== null && region.renderMs === 0)
      region.renderMs = Math.max(0.01, performance.now() - started);
  }

  private renderBundle(bundle: Bundle): void {
    const stores = this.stores;
    const workspace = stores.workspace.getState();
    const areas = stores.areas.getState();
    const effects = stores.effects.getState();
    const edit = stores.edit.getState();
    const drawingState = stores.drawing.getState();
    const view = stores.mapView.getState();
    const now = this.workspace.ctx.clock.getState().now;
    const me = stores.auth.getState().user;
    const tokens = this.tokens;
    const hidden = new Set(effects.hidden);
    if (edit.edit !== null) hidden.add(edit.edit.areaId);
    const viewport = view.viewport === null ? null : expandBbox(view.viewport, 0.5);
    bundle.areas.sync(areas.byId, viewport, tokens, hidden);

    const selected =
      workspace.selectedAreaId === null ? null : (areas.byId.get(workspace.selectedAreaId) ?? null);
    const hover = workspace.hoverAreaId === null ? null : (areas.byId.get(workspace.hoverAreaId) ?? null);
    const lockViews = [];
    for (const lock of stores.locks.getState().locks.values()) {
      const area = areas.byId.get(lock.areaId);
      const visible = activeLock(stores.locks.getState(), lock.areaId, me?.id ?? null, now);
      if (area === undefined || visible === null || (hidden.has(area.id) && edit.edit?.areaId !== area.id))
        continue;
      lockViews.push({ lock: visible, area, both: edit.edit?.areaId === area.id });
    }
    const pulses = [];
    for (const pulse of effects.pulses.values()) {
      const area = areas.byId.get(pulse.areaId);
      if (area !== undefined && pulse.until > now) pulses.push({ pulse, area });
    }
    const preview = workspace.preview;
    const conflict = workspace.conflict;
    // Not while `flyToBounds` runs: a path added mid-fly is projected from the in-flight view into an SVG renderer
    // whose transform was set when the fly started, so the selection floated away from its shape until moveend (on
    // phones, up to 80 px for most of a second). What is already drawn follows the fly; moveend renders again.
    if (!this.flying)
      bundle.decorations.sync({
        selected: edit.edit === null ? selected : null,
        hover: workspace.mode === 'browse' || workspace.mode === 'area-selected' ? hover : null,
        locks: lockViews,
        pulses,
        ghost: preview?.version.geometry?.coordinates ?? null,
        conflict:
          conflict?.origin !== 'shape'
            ? null
            : {
                mine: conflict.showMine ? (conflict.mine.rings ?? null) : null,
                theirs: conflict.showTheirs ? conflict.current.geometry.coordinates : null,
                theirsColor: conflict.current.updatedBy.color,
                theirsName: conflict.current.updatedBy.displayName,
              },
        marker: edit.serverInvalid?.location ?? null,
        selectedChip: this.mercatorZoom(bundle) >= SELECTED_CHIP_MIN_ZOOM,
        tokens,
      });

    const mode = workspace.mode;
    const limits = drawingLimits(stores.runtime.getState().config);
    const derived = deriveDrawing(drawingState.drawing, limits);
    const stage =
      mode === 'drawing'
        ? 'drawing'
        : mode === 'naming'
          ? 'finished'
          : mode === 'saving-new'
            ? 'saving'
            : 'hidden';
    const live = mode === 'drawing' && this.showsPointerPreview();
    bundle.own.sync({
      stage,
      points: drawingState.drawing.points,
      provisional: live ? derived.provisional : null,
      pointer: live ? derived.pointer : null,
      invalid: mode === 'drawing' ? derived.invalid : null,
      serverMarker: drawingState.serverInvalid?.location ?? null,
      firstPointHot: this.firstPointHot,
    });

    const drafts = [...stores.remoteDrafts.getState().drafts.values()].map((draft) => ({
      draft,
      idle: isDraftIdle(draft, now),
    }));
    bundle.remote.sync(drafts, { quiet: workspace.quietMode, narrow: this.deps.isPhone() });
    bundle.editor.sync(
      edit.edit === null ||
        (mode !== 'editing-shape' && mode !== 'saving-edit' && mode !== 'resolving-conflict')
        ? null
        : {
            points: edit.edit.points,
            selected: edit.edit.selected,
            moveArmed: edit.edit.moveArmed,
            dragging: edit.dragging,
            saving: edit.saving || mode === 'resolving-conflict',
            coarse: this.deps.coarsePointer(),
          },
    );
  }

  // -- MapBridge -----------------------------------------------------------------------------

  focusMap(): void {
    this.deps.host.focus({ preventScroll: true });
  }

  center(): Position | null {
    const center = this.primary.instance.map.getCenter();
    return [center.lng, center.lat];
  }

  /** What covers the map from inside (overlay inspector, phone sheet, attribution), from the frame's CSS. */
  private insets(): MapInsets {
    return readMapInsets(getComputedStyle(this.deps.host));
  }

  /** Fit padding that keeps the shape clear of the insets (UI.md section 4.4). */
  private fitPadding(): Pick<L.FitBoundsOptions, 'paddingTopLeft' | 'paddingBottomRight'> {
    const insets = this.insets();
    return {
      paddingTopLeft: [FIT_PADDING_PX + insets.left, FIT_PADDING_PX + insets.top],
      paddingBottomRight: [FIT_PADDING_PX + insets.right, FIT_PADDING_PX + insets.bottom],
    };
  }

  fitPositions(positions: readonly Position[]): void {
    if (positions.length === 0) return;
    const bounds = L.latLngBounds(positions.map((position) => toLatLng(position)));
    this.primary.instance.map.fitBounds(bounds, {
      ...this.fitPadding(),
      maxZoom: this.primary.kind === 'itm' ? 12 : 18,
      animate: !this.deps.reducedMotion(),
    });
  }

  /**
   * Flies to `bbox` in the free map area. The fly waits one frame: it is usually asked for by the same action that
   * changes what covers the map (a list tap snaps the phone sheet from expanded to peek, C-10), and its padding must
   * clear the layout that action leaves, not the one it replaces. `flying` is set at once so a reveal cannot start.
   */
  flyToBbox(bbox: Bbox): void {
    if (this.flyFrame !== null) this.deps.frames.cancel(this.flyFrame);
    this.flying = true;
    this.flyFrame = this.deps.frames.request(() => {
      this.flyFrame = null;
      if (!this.disposed) this.flyNow(bbox);
    });
  }

  private flyNow(bbox: Bbox): void {
    const bounds = L.latLngBounds([bbox[1], bbox[0]], [bbox[3], bbox[2]]);
    const map = this.primary.instance.map;
    if (this.deps.reducedMotion()) {
      this.flying = false;
      map.fitBounds(bounds, {
        ...this.fitPadding(),
        maxZoom: this.primary.kind === 'itm' ? 12 : 18,
        animate: false,
      });
      return;
    }
    map.once('moveend', () => {
      this.flying = false;
    });
    map.flyToBounds(bounds, {
      ...this.fitPadding(),
      maxZoom: this.primary.kind === 'itm' ? 12 : 18,
      duration: 0.7,
    });
  }

  /**
   * Pans `bbox` out from under the overlay inspector or the sheet (UX section 3.2); zooms out only when it cannot fit. A
   * fly in progress already aims at the free area (its padding includes the insets), so it is left alone.
   */
  revealBbox(bbox: Bbox, padding: number = REVEAL_PADDING_PX + this.tokens.bracketOffset): void {
    if (this.flying) return;
    const map = this.primary.instance.map;
    const [northWest, southEast] = bboxCorners(bbox);
    const a = map.latLngToContainerPoint(toLatLng(northWest));
    const b = map.latLngToContainerPoint(toLatLng(southEast));
    const box = {
      left: Math.min(a.x, b.x),
      top: Math.min(a.y, b.y),
      right: Math.max(a.x, b.x),
      bottom: Math.max(a.y, b.y),
    };
    const size = map.getSize();
    const move = panIntoFreeArea(box, { x: size.x, y: size.y }, this.revealInsets(), padding);
    if (move === null) return;
    if (move === 'too-large') {
      this.fitPositions([northWest, southEast]);
      return;
    }
    map.panBy([move.dx, move.dy], { animate: !this.deps.reducedMotion(), duration: LAYER_FADE_MS / 1000 });
  }

  /**
   * The insets a reveal keeps clear. On phones the control row (layer toggle, zoom pair) rides above the sheet or the
   * attribution and is a 44 px target row, so the free strip ends above it (UX section 3.2 "the sheet (or the control row)").
   */
  private revealInsets(): MapInsets {
    const insets = this.insets();
    if (!this.deps.isPhone()) return insets;
    const controls = this.appRoot()?.querySelector<HTMLElement>('.map-controls');
    if (controls === null || controls === undefined) return insets;
    const origin = this.primary.instance.container.getBoundingClientRect();
    const rect = controls.getBoundingClientRect();
    if (rect.height === 0) return insets;
    return { ...insets, bottom: Math.max(insets.bottom, origin.bottom - rect.top) };
  }

  /** Phones: the shape into the free strip once the HUD, sheet and map size have settled (two frames). */
  private schedulePhoneReveal(): void {
    if (this.revealFrame !== null) this.deps.frames.cancel(this.revealFrame);
    this.revealFrame = this.deps.frames.request(() => {
      this.revealFrame = this.deps.frames.request(() => {
        this.revealFrame = null;
        if (!this.disposed) this.revealForPhone();
      });
    });
  }

  private revealForPhone(): void {
    const state = this.stores.workspace.getState();
    if (state.mode === 'editing-shape') {
      const bbox = pointsBbox(this.stores.edit.getState().edit?.points ?? []);
      if (bbox !== null) this.revealBbox(bbox, HANDLE_REVEAL_PADDING_PX);
      return;
    }
    if (state.mode === 'drawing') {
      const bbox = pointsBbox(this.stores.drawing.getState().drawing.points);
      if (bbox !== null) this.revealBbox(bbox, HANDLE_REVEAL_PADDING_PX);
      return;
    }
    if (state.mode !== 'area-selected' || state.selectedAreaId === null) return;
    const area = this.stores.areas.getState().byId.get(state.selectedAreaId);
    if (area !== undefined) this.revealBbox(area.bbox);
  }

  // -- chip placement (UI.md section 9.8) ------------------------------------------------------------

  private appRoot(): ParentNode | null {
    return this.deps.host.closest('.app') ?? this.deps.host.ownerDocument;
  }

  /** The boxes of what floats over the map, in map-container pixels. */
  private chipObstacles(origin: DOMRect): ScreenBox[] {
    const root = this.appRoot();
    if (root === null) return [];
    const boxes: ScreenBox[] = [];
    for (const element of root.querySelectorAll<HTMLElement>(CHIP_OBSTACLES)) {
      const rect = element.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) continue;
      boxes.push({
        left: rect.left - origin.left,
        top: rect.top - origin.top,
        right: rect.right - origin.left,
        bottom: rect.bottom - origin.top,
      });
    }
    return boxes;
  }

  /**
   * Places every chip of the visible map by the section 9.8 rules (flip, collapse to a disc, newer wins, slide inward). A
   * chip hangs off a 0 x 0 icon at its anchor, so the placement is a transform relative to that point; a collapsed
   * chip keeps its full text in `title` and its data attributes (`data-km2` and friends) untouched.
   */
  private layoutChips(): void {
    const { map, container } = this.primary.instance;
    const pane = map.getPane(PANES.chips.name);
    const chips = pane === undefined ? [] : [...pane.querySelectorAll<HTMLElement>('.snap-chip')];
    if (chips.length === 0) return;
    const origin = container.getBoundingClientRect();
    const inputs: ChipToPlace[] = chips.map((chip) => {
      let size = this.chipSizes.get(chip);
      if (size === undefined) {
        // Measured before its first placement, while it still has its full width.
        size = { width: chip.offsetWidth, height: chip.offsetHeight };
        this.chipSizes.set(chip, size);
      }
      const anchor = (chip.parentElement ?? chip).getBoundingClientRect();
      const time = Number(chip.dataset['chipTime']);
      return {
        anchor: { x: anchor.left - origin.left, y: anchor.top - origin.top },
        width: size.width,
        height: size.height,
        anchoring: chip.classList.contains('snap-chip--centred') ? 'centred' : 'side',
        time: Number.isFinite(time) ? time : Infinity,
        disc: chip.classList.contains('snap-chip--disc'),
        collapsible: chip.dataset['initials'] !== undefined,
      };
    });
    const size = map.getSize();
    const insets = this.insets();
    const visible: ScreenBox = {
      left: insets.left,
      top: insets.top,
      right: size.x - insets.right,
      bottom: size.y - insets.bottom,
    };
    const placements = placeChips(inputs, this.chipObstacles(origin), visible);
    chips.forEach((chip, index) => {
      const placement = placements[index];
      const input = inputs[index];
      if (placement === undefined || input === undefined) return;
      const dx = Math.round(placement.box.left - input.anchor.x);
      const dy = Math.round(placement.box.top - input.anchor.y);
      const transform = `translate(${String(dx)}px, ${String(dy)}px)`;
      if (chip.dataset['placement'] !== placement.side) chip.dataset['placement'] = placement.side;
      if (chip.style.transform !== transform) chip.style.transform = transform;
    });
  }

  zoomBy(delta: number): void {
    const map = this.primary.instance.map;
    map.setZoom(map.getZoom() + delta, { animate: !this.deps.reducedMotion() });
  }

  project(position: Position): { x: number; y: number } | null {
    const point = this.primary.instance.map.latLngToContainerPoint(toLatLng(position));
    return { x: point.x, y: point.y };
  }

  offset(position: Position, dx: number, dy: number): Position | null {
    const map = this.primary.instance.map;
    const point = map.latLngToContainerPoint(toLatLng(position)).add([dx, dy]);
    return fromLatLng(map.containerPointToLatLng(point));
  }

  /**
   * Keeps a point out from under the notice slot (top), the overlay inspector (right) and the toasts, the sheet and
   * the attribution (bottom), UX-AC-99. Docked chrome is outside the map and needs no margin.
   */
  ensureVisible(position: Position): void {
    const map = this.primary.instance.map;
    const size = map.getSize();
    const point = map.latLngToContainerPoint(toLatLng(position));
    const insets = this.insets();
    const safe = {
      top: insets.top + VISIBLE_MARGIN_TOP_PX,
      bottom: size.y - insets.bottom - VISIBLE_MARGIN_BOTTOM_PX,
      left: insets.left + VISIBLE_MARGIN_SIDE_PX,
      right: size.x - insets.right - VISIBLE_MARGIN_SIDE_PX,
    };
    let dx = 0;
    let dy = 0;
    if (point.x < safe.left) dx = point.x - safe.left;
    else if (point.x > safe.right) dx = point.x - safe.right;
    if (point.y < safe.top) dy = point.y - safe.top;
    else if (point.y > safe.bottom) dy = point.y - safe.bottom;
    if (dx !== 0 || dy !== 0)
      map.panBy([dx, dy], { animate: !this.deps.reducedMotion(), duration: LAYER_FADE_MS / 1000 });
  }

  // -- teardown ------------------------------------------------------------------------------

  dispose(): void {
    this.disposed = true;
    for (const unsubscribe of this.unsubscribers.splice(0)) unsubscribe();
    if (this.renderFrame !== null) this.deps.frames.cancel(this.renderFrame);
    if (this.pointerFrame !== null) this.deps.frames.cancel(this.pointerFrame);
    if (this.flyFrame !== null) this.deps.frames.cancel(this.flyFrame);
    if (this.revealFrame !== null) this.deps.frames.cancel(this.revealFrame);
    this.hideTooltip();
    this.deps.scheduler.clearTimeout(this.dblClickTimer);
    this.containerFade.dispose();
    const primary = this.primary;
    for (const bundle of [...this.bundles]) {
      if (bundle !== primary) this.disposeBundle(bundle);
    }
    primary.fade.dispose();
    primary.areas.dispose();
    primary.decorations.dispose();
    primary.own.dispose();
    primary.remote.dispose();
    primary.editor.dispose();
    primary.instance.dispose();
    this.bundles = [];
  }
}
