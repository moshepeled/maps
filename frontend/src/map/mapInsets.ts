/**
 * What covers the map from inside its box (UI.md section 4.4): the Studio frame writes these runtime custom properties on
 * the app root - the overlay inspector's width (`--map-inset-right`), the phone sheet (`--map-inset-bottom`), the
 * attribution's height - and the map reads them, so fits, pans and "keep this point visible" leave those strips
 * clear. Docked chrome (title bar, rail, options bar, docked inspector, status bar) is outside the map and needs none.
 */
import type { Bbox } from '@snapland/shared';

export interface MapInsets {
  top: number;
  right: number;
  bottom: number;
  left: number;
}

export const NO_INSETS: MapInsets = { top: 0, right: 0, bottom: 0, left: 0 };

function px(style: Pick<CSSStyleDeclaration, 'getPropertyValue'>, name: string): number {
  const value = Number.parseFloat(style.getPropertyValue(name));
  return Number.isFinite(value) && value > 0 ? value : 0;
}

/** The insets in effect for `element` (custom properties inherit from the app root). */
export function readMapInsets(style: Pick<CSSStyleDeclaration, 'getPropertyValue'>): MapInsets {
  return {
    top: px(style, '--map-inset-top'),
    right: px(style, '--map-inset-right'),
    bottom: px(style, '--map-inset-bottom') + px(style, '--map-attribution-h'),
    left: 0,
  };
}

export interface ScreenBox {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

/**
 * The pan (screen pixels, as for `map.panBy`) that brings `box` inside the free map area - the container minus the
 * insets and `padding` - or null when it is already inside, or when it cannot fit at this zoom (the caller then
 * fits the bounds instead, zooming out only in that case: UX section 3.2 "it zooms out only if the shape cannot fit").
 */
export function panIntoFreeArea(
  box: ScreenBox,
  size: { x: number; y: number },
  insets: MapInsets,
  padding: number,
): { dx: number; dy: number } | 'too-large' | null {
  const free = {
    left: insets.left + padding,
    top: insets.top + padding,
    right: size.x - insets.right - padding,
    bottom: size.y - insets.bottom - padding,
  };
  if (box.right - box.left > free.right - free.left || box.bottom - box.top > free.bottom - free.top)
    return 'too-large';
  const dx =
    box.left < free.left ? box.left - free.left : box.right > free.right ? box.right - free.right : 0;
  const dy =
    box.top < free.top ? box.top - free.top : box.bottom > free.bottom ? box.bottom - free.bottom : 0;
  return dx === 0 && dy === 0 ? null : { dx, dy };
}

/** The corners of a bbox as [lng, lat] positions (for projecting it to the screen). */
export function bboxCorners(bbox: Bbox): [[number, number], [number, number]] {
  return [
    [bbox[0], bbox[3]],
    [bbox[2], bbox[1]],
  ];
}
