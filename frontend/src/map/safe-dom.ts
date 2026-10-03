/**
 * The single wrapper around Leaflet's HTML sinks (SPEC section 10.7.1, lint-enforced): tooltips, chips, badges and handle
 * icons are built as `HTMLElement`s whose text is set with `textContent`, then handed to Leaflet as elements - so a
 * user-controlled string (area name, display name) can never be parsed as HTML. No function here accepts markup.
 */
import L from 'leaflet';

/** Attribute names that could execute script or restyle beyond our tokens are refused. */
const SAFE_ATTRIBUTE = /^(?:data-[a-z0-9-]+|aria-[a-z-]+|class|title|role|dir|tabindex|id)$/u;
const HEX_COLOR = /^#[0-9a-fA-F]{6}$/u;
const SVG_NS = 'http://www.w3.org/2000/svg';

export type SafeAttributes = Readonly<Record<string, string | number | boolean | null | undefined>>;

function applyAttributes(element: HTMLElement, attributes: SafeAttributes): void {
  for (const [name, value] of Object.entries(attributes)) {
    if (value === null || value === undefined || value === false) continue;
    if (!SAFE_ATTRIBUTE.test(name)) throw new Error(`safe-dom: attribute ${name} is not allowed`);
    element.setAttribute(name, value === true ? '' : String(value));
  }
}

/** `<tag>` with `text` as its text content (never parsed) and allow-listed attributes. */
export function textElement(
  tag: keyof HTMLElementTagNameMap,
  text: string,
  attributes: SafeAttributes = {},
): HTMLElement {
  const element = document.createElement(tag);
  element.textContent = text;
  applyAttributes(element, attributes);
  return element;
}

/** A container element built from children (each already safe). */
export function groupElement(
  tag: keyof HTMLElementTagNameMap,
  children: readonly Element[],
  attributes: SafeAttributes = {},
): HTMLElement {
  const element = document.createElement(tag);
  applyAttributes(element, attributes);
  for (const child of children) element.append(child);
  return element;
}

/**
 * A decorative 24-grid line icon (chips, UI.md section 9.8) drawn from path data the app ships as constants - never user
 * input. It is `aria-hidden`; CSS strokes it with `currentColor`.
 */
export function svgIcon(paths: readonly string[], className: string): SVGSVGElement {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('class', className);
  svg.setAttribute('aria-hidden', 'true');
  for (const d of paths) {
    const path = document.createElementNS(SVG_NS, 'path');
    path.setAttribute('d', d);
    svg.append(path);
  }
  return svg;
}

/** Sets the person colour custom property `--c` (validated `#rrggbb`, UI.md section 14.4). */
export function withPersonColor<T extends HTMLElement>(element: T, color: string): T {
  if (HEX_COLOR.test(color)) element.style.setProperty('--c', color);
  return element;
}

export interface ElementIconOptions {
  className?: string;
  iconSize?: L.PointExpression;
  iconAnchor?: L.PointExpression;
}

/** A Leaflet `DivIcon` whose content is an element (never an HTML string). */
export function elementIcon(element: HTMLElement, options: ElementIconOptions = {}): L.DivIcon {
  return L.divIcon({ ...options, html: element, className: options.className ?? 'snap-icon' });
}

/** Binds a tooltip whose content is an element built by `textElement` / `groupElement`. */
export function bindElementTooltip(
  layer: L.Layer,
  element: HTMLElement,
  options: L.TooltipOptions = {},
): void {
  layer.bindTooltip(element, options);
}

/** Replaces a bound tooltip's content with another safe element. */
export function setElementTooltip(layer: L.Layer, element: HTMLElement): void {
  layer.setTooltipContent(element);
}

/** Opens a standalone tooltip at `latlng` whose content is a safe element (the area hover tooltip, UX C-08). */
export function openElementTooltip(
  map: L.Map,
  latlng: L.LatLngExpression,
  element: HTMLElement,
  options: L.TooltipOptions = {},
): L.Tooltip {
  const tooltip = L.tooltip(options);
  tooltip.setLatLng(latlng);
  tooltip.setContent(element);
  tooltip.addTo(map);
  return tooltip;
}
