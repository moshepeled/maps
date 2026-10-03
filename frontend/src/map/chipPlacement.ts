/**
 * Where each map chip goes (UI.md section 9.8 "Rules, applied in this order on every render"), as a pure function of screen
 * boxes so the rules are unit-tested without Leaflet or a layout engine:
 *
 * 1. A chip that is already a disc (a lock on an area under 24 px) stays a disc on its anchor.
 * 2. A chip whose box would meet something floating over the map (notices, the control column or row, the overlay
 *    inspector, the sheet, the toast lane, the attribution) flips to the other side of its anchor. If both sides
 *    collide, it becomes an initials disc on the anchor; a disc that is still under something moves vertically clear
 *    of it (above it, else below), so a collaborator never disappears under a toast.
 * 3. When two chips overlap, the newer one stays full and the older one collapses to a disc (a disc never collapses
 *    further).
 * 4. (Below 600 px remote draft chips drop the km²: that is copy, decided where the chip is built.)
 *
 * A chip never leaves the visible map: every box slides inward to `CHIP_EDGE_PX` from the visible edge.
 */
import type { ScreenBox } from './mapInsets';

/** A side chip sits this far from its anchor (UI.md section 9.5 "12 px to the right, vertically centred"). */
export const CHIP_GAP_PX = 12;
/** How far inside the visible map a chip stays (UI.md section 9.8 "slides inward to 8 px from the edge"). */
export const CHIP_EDGE_PX = 8;
/** `--size-chip-disc`. */
export const CHIP_DISC_PX = 20;

export type ChipAnchoring = 'side' | 'centred';
export type ChipSide = 'right' | 'left' | 'centre' | 'disc';

export interface ChipToPlace {
  /** The anchor in map-container pixels. */
  anchor: { x: number; y: number };
  /** The full chip's size in pixels. */
  width: number;
  height: number;
  /** Person chips hang 12 px off their anchor (draft chips); area chips centre on the label point. */
  anchoring: ChipAnchoring;
  /** Larger is newer: of two overlapping chips the newer stays full. `Infinity` for my own chips. */
  time: number;
  /** Already an initials disc (rule 1). */
  disc: boolean;
  /** Whether the chip may collapse to an initials disc; neutral chips have no person to abbreviate. */
  collapsible: boolean;
}

export interface ChipPlacement {
  side: ChipSide;
  /** The box the chip occupies, in map-container pixels, after sliding inward. */
  box: ScreenBox;
}

function intersects(a: ScreenBox, b: ScreenBox): boolean {
  return a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;
}

function inside(box: ScreenBox, area: ScreenBox): boolean {
  return box.left >= area.left && box.right <= area.right && box.top >= area.top && box.bottom <= area.bottom;
}

/** Slides `box` so it lies `CHIP_EDGE_PX` inside `visible` (its left/top edge wins when it is wider than the map). */
export function slideInward(box: ScreenBox, visible: ScreenBox): ScreenBox {
  const minX = visible.left + CHIP_EDGE_PX;
  const maxX = visible.right - CHIP_EDGE_PX;
  const minY = visible.top + CHIP_EDGE_PX;
  const maxY = visible.bottom - CHIP_EDGE_PX;
  let dx = box.right > maxX ? maxX - box.right : 0;
  if (box.left + dx < minX) dx = minX - box.left;
  let dy = box.bottom > maxY ? maxY - box.bottom : 0;
  if (box.top + dy < minY) dy = minY - box.top;
  return { left: box.left + dx, right: box.right + dx, top: box.top + dy, bottom: box.bottom + dy };
}

function boxAt(chip: ChipToPlace, side: Exclude<ChipSide, 'disc'>): ScreenBox {
  const { x, y } = chip.anchor;
  const top = y - chip.height / 2;
  const bottom = top + chip.height;
  if (side === 'right') return { left: x + CHIP_GAP_PX, right: x + CHIP_GAP_PX + chip.width, top, bottom };
  if (side === 'left') return { left: x - CHIP_GAP_PX - chip.width, right: x - CHIP_GAP_PX, top, bottom };
  return { left: x - chip.width / 2, right: x + chip.width / 2, top, bottom };
}

function discAt(chip: ChipToPlace): ScreenBox {
  const half = CHIP_DISC_PX / 2;
  const { x, y } = chip.anchor;
  return { left: x - half, right: x + half, top: y - half, bottom: y + half };
}

/**
 * The first side whose box is clear of every obstacle: first as drawn at the anchor, then slid inward (a chip that
 * would run off the visible map keeps its side if sliding clears it). Null when every side collides.
 */
function clearSide(
  chip: ChipToPlace,
  obstacles: readonly ScreenBox[],
  visible: ScreenBox,
): ChipPlacement | null {
  const sides: Exclude<ChipSide, 'disc'>[] =
    chip.anchoring === 'centred' ? ['centre', 'right', 'left'] : ['right', 'left'];
  const clear = (box: ScreenBox): boolean => !obstacles.some((obstacle) => intersects(box, obstacle));
  const margin: ScreenBox = {
    left: visible.left + CHIP_EDGE_PX,
    right: visible.right - CHIP_EDGE_PX,
    top: visible.top + CHIP_EDGE_PX,
    bottom: visible.bottom - CHIP_EDGE_PX,
  };
  for (const side of sides) {
    const box = boxAt(chip, side);
    if (inside(box, margin) && clear(box)) return { side, box };
  }
  for (const side of sides) {
    const box = slideInward(boxAt(chip, side), visible);
    if (clear(box)) return { side, box };
  }
  return null;
}

/**
 * Moves `box` vertically clear of the first obstacle it meets: above it, else below it, each slid back inside the
 * visible map. A box that fits neither way stays where it is.
 */
function moveClear(box: ScreenBox, obstacles: readonly ScreenBox[], visible: ScreenBox): ScreenBox {
  const blocked = (candidate: ScreenBox): boolean =>
    obstacles.some((obstacle) => intersects(candidate, obstacle));
  const hit = obstacles.find((obstacle) => intersects(box, obstacle));
  if (hit === undefined) return box;
  const height = box.bottom - box.top;
  const aboveTop = hit.top - CHIP_EDGE_PX - height;
  const above = slideInward({ ...box, top: aboveTop, bottom: aboveTop + height }, visible);
  if (!blocked(above)) return above;
  const belowTop = hit.bottom + CHIP_EDGE_PX;
  const below = slideInward({ ...box, top: belowTop, bottom: belowTop + height }, visible);
  return blocked(below) ? box : below;
}

/**
 * Places every chip. `obstacles` and `visible` are in the same map-container pixels as the anchors; `visible` is the
 * part of the map not covered by insets. The result is index-aligned with `chips`.
 */
export function placeChips(
  chips: readonly ChipToPlace[],
  obstacles: readonly ScreenBox[],
  visible: ScreenBox,
): ChipPlacement[] {
  const placements: ChipPlacement[] = new Array<ChipPlacement>(chips.length);
  // Newest first, so an older chip that overlaps an already placed newer one is the one that collapses (rule 3).
  // (Compared, not subtracted: my own chips are `Infinity`, and Infinity − Infinity is NaN.)
  const newer = (a: number, b: number): number => {
    const timeA = chips[a]?.time ?? 0;
    const timeB = chips[b]?.time ?? 0;
    return timeA === timeB ? a - b : timeA > timeB ? -1 : 1;
  };
  const order = chips.map((_, index) => index).sort(newer);
  const fullChips: ScreenBox[] = [];
  for (const index of order) {
    const chip = chips[index];
    if (chip === undefined) continue;
    const disc: ChipPlacement = { side: 'disc', box: slideInward(discAt(chip), visible) };
    const placed = chip.disc ? null : clearSide(chip, obstacles, visible);
    let result: ChipPlacement;
    if (chip.disc) {
      result = disc;
    } else if (placed === null) {
      // Both sides collide: a disc on the anchor; a chip that cannot collapse keeps its first side, slid inward.
      const side = chip.anchoring === 'centred' ? 'centre' : 'right';
      result = chip.collapsible ? disc : { side, box: slideInward(boxAt(chip, side), visible) };
    } else if (chip.collapsible && fullChips.some((box) => intersects(box, placed.box))) {
      result = disc;
    } else {
      result = placed;
    }
    // A flipped side is already clear; a disc or an unflippable chip may still sit under a toast or a notice.
    result = { side: result.side, box: moveClear(result.box, obstacles, visible) };
    placements[index] = result;
    if (result.side !== 'disc') fullChips.push(result.box);
  }
  return placements;
}
