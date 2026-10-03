/**
 * Helpers shared by the overlay layers (UI.md section 9): coordinate order, test-id tagging of SVG paths, the core + casing
 * line recipe, chips and glyphs built through `safe-dom.ts`, the screen geometry of the selection brackets and the
 * invalid ticks, and the few overlay tokens JavaScript needs (the saved-areas canvas cannot read CSS; brackets are
 * measured in pixels). Every other overlay colour and width is applied by map.css from the map-tone tokens.
 */
import type { Position } from '@snapland/shared';
import L from 'leaflet';

import { initials } from '../lib/text';
import type { PaneKey } from './mapInstance';
import { PANES } from './mapInstance';
import type { ScreenBox } from './mapInsets';
import type { SafeAttributes } from './safe-dom';
import { elementIcon, groupElement, svgIcon, textElement, withPersonColor } from './safe-dom';

export function toLatLng(position: Position): L.LatLngTuple {
  return [position[1], position[0]];
}

export function toLatLngs(positions: readonly Position[]): L.LatLngTuple[] {
  return positions.map(toLatLng);
}

export function fromLatLng(latlng: L.LatLng): Position {
  return [latlng.lng, latlng.lat];
}

/** Sets attributes (test ids, data-*) on a vector layer's SVG element once it is on the map. */
export function tagLayer(layer: L.Path, attributes: SafeAttributes): void {
  const element = layer.getElement();
  if (element === undefined) return;
  for (const [name, value] of Object.entries(attributes)) {
    if (value === null || value === undefined || value === false) element.removeAttribute(name);
    else element.setAttribute(name, value === true ? 'true' : String(value));
  }
}

// -- lines: a core on a casing (UI.md section 9.2) --------------------------------------------------

export interface CasedPathOptions {
  renderer: L.Renderer;
  /** Role class(es) in map.css: they set the core's width, dash and colour and the casing's extra width. */
  role: string;
  /** A closed ring (polygon) or an open line. */
  closed: boolean;
  /** The map-tone casing, the dark casing every collaborator colour keeps, or none (UI.md section 2.5). */
  casing?: 'tone' | 'remote' | 'none';
  /** The core also paints the shape's fill (closed shapes only). */
  fill?: boolean;
  /** A person's colour for the core and its fill; map.css colours every other role. */
  color?: string;
  /** The white outline outside the casing that lets an invalid edge reach 3:1 on dark imagery (UI.md section 9.7). */
  outline?: boolean;
}

/** An open line or a closed ring (both have `setLatLngs`). */
export type OverlayLine = L.Polyline | L.Polygon;

export interface CasedPath {
  /** Bottom to top: outline, casing, core. Add them in this order. */
  layers: OverlayLine[];
  /** The visible line: the element that carries test ids. */
  core: OverlayLine;
}

/** One overlay line as up to three non-interactive SVG paths, classed `ov-outline` / `ov-casing` / `ov-core`. */
export function casedPath(
  latlngs: L.LatLngExpression[] | L.LatLngExpression[][],
  options: CasedPathOptions,
): CasedPath {
  const path = (part: string, extra: L.PathOptions = {}): OverlayLine => {
    const pathOptions: L.PathOptions = {
      renderer: options.renderer,
      interactive: false,
      fill: false,
      className: `${part} ${options.role}`,
      ...extra,
    };
    if (options.closed) return L.polygon(latlngs, pathOptions);
    const line: L.Polyline = L.polyline(latlngs, pathOptions);
    return line;
  };
  const layers: OverlayLine[] = [];
  if (options.outline === true) layers.push(path('ov-outline'));
  const casing = options.casing ?? 'tone';
  if (casing !== 'none') layers.push(path(casing === 'remote' ? 'ov-casing ov-casing--remote' : 'ov-casing'));
  const fill = options.fill === true && options.closed;
  const personColor = options.color === undefined ? {} : { color: options.color, fillColor: options.color };
  const core = path(fill ? 'ov-core ov-fill' : 'ov-core', { ...personColor, fill });
  layers.push(core);
  return { layers, core };
}

// -- glyphs and chips (divIcons styled by map.css) -------------------------------------------

/** A non-interactive marker whose 0 x 0 icon anchors `element` at `latlng` (CSS centres or offsets it). */
export function anchoredMarker(latlng: L.LatLngExpression, element: HTMLElement, pane: PaneKey): L.Marker {
  return L.marker(latlng, {
    icon: elementIcon(element, { className: 'snap-anchor-icon', iconSize: undefined, iconAnchor: [0, 0] }),
    interactive: false,
    keyboard: false,
    pane: PANES[pane].name,
  });
}

/** A non-interactive marker in the chips pane carrying `element`. */
export function chipMarker(latlng: L.LatLngExpression, element: HTMLElement): L.Marker {
  return anchoredMarker(latlng, element, 'chips');
}

/** The x marker on a crossing or a server-reported problem location (UI.md section 9.7, `invalid-marker`). */
export function invalidMarker(latlng: L.LatLngExpression): L.Marker {
  const element = textElement('div', 'x', {
    class: 'snap-invalid-marker',
    'data-testid': 'invalid-marker',
    'aria-hidden': true,
  });
  return L.marker(latlng, {
    icon: elementIcon(element, { className: 'snap-marker-icon', iconSize: [20, 20], iconAnchor: [10, 10] }),
    interactive: false,
    keyboard: false,
    pane: PANES.chips.name,
  });
}

/** A 14 px x tick on an invalid edge: a pattern that does not rely on the red (UI.md section 9.7). */
export function invalidTickMarker(latlng: L.LatLngExpression): L.Marker {
  return anchoredMarker(
    latlng,
    groupElement('span', [], { class: 'snap-invalid-tick', 'aria-hidden': true }),
    'chips',
  );
}

export type ChipIcon = 'plus' | 'pencil' | 'spinner';

/** Lucide paths (ISC), the same icons as components/Icon.tsx. */
const CHIP_ICON_PATHS: Record<Exclude<ChipIcon, 'spinner'>, readonly string[]> = {
  plus: ['M5 12h14', 'M12 5v14'],
  pencil: [
    'M21.174 6.812a1 1 0 0 0-3.986-3.987L3.842 16.174a2 2 0 0 0-.5.83l-1.321 4.352a.5.5 0 0 0 .623.622l4.353-1.32a2 2 0 0 0 .83-.497z',
    'm15 5 4 4',
  ],
};

export interface ChipOptions {
  text: string;
  /** A value set in mono after the text (the km²). It is part of the chip's text content. */
  value?: string;
  /** A leading icon (never on the compact disc). */
  icon?: ChipIcon;
  title?: string;
  color?: string | null;
  /** `data-testid`; the [N] selected chip has none (it is not in the UX section 12 registry). */
  testId?: string;
  attributes?: SafeAttributes;
  className?: string;
  /** Collapse to an initials disc (UI.md section 9.8) - `initialsOf` is the full name. */
  compact?: boolean;
  /**
   * A person's full name: its initials are what the chip shows when it is (or the placement pass collapses it to) a
   * disc. Chips without one (neutral chips) never collapse.
   */
  initialsOf?: string;
  /**
   * When what the chip reports last changed (ms): of two overlapping chips the newer stays full (UI.md section 9.8 rule 3).
   * Omitted for my own chips, which always stay full.
   */
  time?: number;
}

function chipIcon(icon: ChipIcon): Element {
  if (icon === 'spinner') return groupElement('span', [], { class: 'spinner xs', 'aria-hidden': true });
  return svgIcon(CHIP_ICON_PATHS[icon], 'snap-chip__icon');
}

/** A person/neutral chip as an element (text only, never HTML). */
export function chipElement(options: ChipOptions): HTMLElement {
  const compact = options.compact === true;
  const children: Element[] = [];
  if (!compact && options.icon !== undefined) children.push(chipIcon(options.icon));
  const content = compact ? initials(options.initialsOf ?? options.text) : options.text;
  children.push(textElement('span', content, { class: 'snap-chip__text' }));
  if (!compact && options.value !== undefined)
    children.push(textElement('span', options.value, { class: 'snap-chip__value' }));
  const chip = groupElement('div', children, {
    class: `snap-chip ${compact ? 'snap-chip--disc' : ''} ${options.className ?? ''}`.trim(),
    'data-testid': options.testId,
    title: options.title ?? options.text,
    // Read by the placement pass (MapController.placeChips): the disc's initials and the chip's age.
    'data-initials': options.initialsOf === undefined ? undefined : initials(options.initialsOf),
    'data-chip-time': options.time,
    ...options.attributes,
  });
  if (options.color !== undefined && options.color !== null) withPersonColor(chip, options.color);
  return chip;
}

// -- screen geometry -------------------------------------------------------------------------

/**
 * The four CAD corner brackets around a screen box (UI.md section 9.4): each is an arm-corner-arm line `offset` px outside
 * the box, with arms `size` px long. Points are [x, y] pixels.
 */
export function bracketLines(box: ScreenBox, offset: number, size: number): [number, number][][] {
  const left = box.left - offset;
  const top = box.top - offset;
  const right = box.right + offset;
  const bottom = box.bottom + offset;
  return [
    [
      [left, top + size],
      [left, top],
      [left + size, top],
    ],
    [
      [right - size, top],
      [right, top],
      [right, top + size],
    ],
    [
      [right, bottom - size],
      [right, bottom],
      [right - size, bottom],
    ],
    [
      [left + size, bottom],
      [left, bottom],
      [left, bottom - size],
    ],
  ];
}

function squaredDistance(a: Position, b: Position): number {
  return (a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2;
}

/**
 * Where the x ticks sit (UI.md section 9.7): halfway between the crossing and each invalid edge's farther endpoint, or at
 * the edge's midpoint when there is no crossing. The crossing lies on the edge, so comparing degrees is enough to
 * pick the farther endpoint.
 */
export function invalidTickPositions(
  edges: readonly (readonly [Position, Position])[],
  crossing: Position | null,
): Position[] {
  return edges.map(([a, b]) => {
    const from = crossing ?? a;
    const to = crossing === null ? b : squaredDistance(crossing, a) >= squaredDistance(crossing, b) ? a : b;
    return [(from[0] + to[0]) / 2, (from[1] + to[1]) / 2];
  });
}

/** The label point used for chips: the bbox centre (cheap and stable across LODs). */
export function labelPoint(bbox: readonly [number, number, number, number]): L.LatLngTuple {
  return [(bbox[1] + bbox[3]) / 2, (bbox[0] + bbox[2]) / 2];
}

// -- tokens JavaScript needs -----------------------------------------------------------------

/** What canvas areas and bracket geometry need from tokens.css; they follow the map tone (theme + base layer). */
export interface OverlayTokens {
  areaStroke: string;
  areaStrokeWidth: number;
  areaFill: string;
  areaFillOpacity: number;
  bracketSize: number;
  bracketOffset: number;
}

type StyleSource = Pick<CSSStyleDeclaration, 'getPropertyValue'>;

function numberToken(style: StyleSource, name: string, fallback: number): number {
  const value = Number.parseFloat(style.getPropertyValue(name));
  return Number.isFinite(value) ? value : fallback;
}

function colorToken(style: StyleSource, name: string, fallback: string): string {
  const value = style.getPropertyValue(name).trim();
  return value === '' ? fallback : value;
}

/**
 * Reads the tokens from the map host's computed style (they switch with `data-base-layer` and the theme). The
 * fallbacks are the dark-tone values (UI.md section 14.4), for a style that is not loaded yet.
 */
export function readOverlayTokens(style: StyleSource): OverlayTokens {
  return {
    areaStroke: colorToken(style, '--ov-area-stroke', '#eef1f5'),
    areaStrokeWidth: numberToken(style, '--ov-area-stroke-width', 1.75),
    areaFill: colorToken(style, '--ov-area-fill', '#ffffff'),
    areaFillOpacity: numberToken(style, '--ov-area-fill-opacity', 0.12),
    bracketSize: numberToken(style, '--ov-bracket-size', 14),
    bracketOffset: numberToken(style, '--ov-bracket-offset', 9),
  };
}
