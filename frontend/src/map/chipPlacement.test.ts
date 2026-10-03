/** The map-chip placement rules (UI.md section 9.8): flip, collapse to a disc, newer wins an overlap, slide inward. */
import { describe, expect, it } from 'vitest';

import type { ChipToPlace } from './chipPlacement';
import { CHIP_DISC_PX, CHIP_EDGE_PX, CHIP_GAP_PX, placeChips, slideInward } from './chipPlacement';
import type { ScreenBox } from './mapInsets';

/** A 972 x 700 map (1024 wide overlay layout minus the 52 px rail). */
const MAP: ScreenBox = { left: 0, top: 0, right: 972, bottom: 700 };

function chip(overrides: Partial<ChipToPlace> = {}): ChipToPlace {
  return {
    anchor: { x: 300, y: 300 },
    width: 232,
    height: 24,
    anchoring: 'side',
    time: 1,
    disc: false,
    collapsible: true,
    ...overrides,
  };
}

describe('placeChips (UI.md section 9.8)', () => {
  it('a chip with room sits 12 px right of its anchor, vertically centred', () => {
    const [placed] = placeChips([chip()], [], MAP);
    expect(placed).toEqual({
      side: 'right',
      box: { left: 300 + CHIP_GAP_PX, right: 300 + CHIP_GAP_PX + 232, top: 288, bottom: 312 },
    });
  });

  it('rule 2: flips to the left of its anchor when the right side meets the overlay inspector', () => {
    // The finding's case: anchor at x 612, overlay inspector from x 622 (its --map-inset-right is 344 + gap).
    const overlay: ScreenBox = { left: 622, top: 10, right: 962, bottom: 660 };
    const visible: ScreenBox = { ...MAP, right: MAP.right - 344 };
    const [placed] = placeChips([chip({ anchor: { x: 612, y: 399 } })], [overlay], visible);
    expect(placed?.side).toBe('left');
    expect(placed?.box.right).toBe(612 - CHIP_GAP_PX);
    expect(placed?.box.left).toBe(612 - CHIP_GAP_PX - 232);
  });

  it('rule 2: becomes a disc on its anchor when both sides collide', () => {
    // A notice to the right and the control column to the left, neither over the anchor itself.
    const right: ScreenBox = { left: 420, top: 380, right: 900, bottom: 420 };
    const left: ScreenBox = { left: 100, top: 380, right: 380, bottom: 420 };
    const [placed] = placeChips([chip({ anchor: { x: 400, y: 400 } })], [right, left], MAP);
    expect(placed?.side).toBe('disc');
    expect(placed?.box).toEqual({
      left: 400 - CHIP_DISC_PX / 2,
      right: 400 + CHIP_DISC_PX / 2,
      top: 400 - CHIP_DISC_PX / 2,
      bottom: 400 + CHIP_DISC_PX / 2,
    });
  });

  it('rule 2: a disc never lands under a toast; it moves up clear of the lane (below it at the top edge)', () => {
    const toastLane: ScreenBox = { left: 0, top: 380, right: 972, bottom: 420 };
    const [placed] = placeChips([chip({ anchor: { x: 400, y: 400 } })], [toastLane], MAP);
    expect(placed?.side).toBe('disc');
    expect(placed?.box).toEqual({
      left: 400 - CHIP_DISC_PX / 2,
      right: 400 + CHIP_DISC_PX / 2,
      top: 380 - CHIP_EDGE_PX - CHIP_DISC_PX,
      bottom: 380 - CHIP_EDGE_PX,
    });
    // A notice across the top of the map has no room above it, so the disc goes below it.
    const notice: ScreenBox = { left: 0, top: 0, right: 972, bottom: 40 };
    const [nearTop] = placeChips([chip({ anchor: { x: 400, y: 20 } })], [notice], MAP);
    expect(nearTop?.box.top).toBe(40 + CHIP_EDGE_PX);
  });

  it('a chip that cannot collapse (neutral "Unsaved") keeps its side instead of becoming a disc', () => {
    const everywhere: ScreenBox = { left: 0, top: 0, right: 972, bottom: 700 };
    const [placed] = placeChips(
      [chip({ anchoring: 'centred', collapsible: false, time: Infinity })],
      [everywhere],
      MAP,
    );
    expect(placed?.side).toBe('centre');
  });

  it('centred chips try the label point first, then either side', () => {
    const [free] = placeChips([chip({ anchoring: 'centred', width: 100 })], [], MAP);
    expect(free?.side).toBe('centre');
    expect(free?.box.left).toBe(250);
    const overCentre: ScreenBox = { left: 240, top: 280, right: 300, bottom: 320 };
    const [flipped] = placeChips([chip({ anchoring: 'centred', width: 100 })], [overCentre], MAP);
    expect(flipped?.side).toBe('right');
  });

  it('rule 3: of two overlapping chips the newer stays full and the older collapses to a disc', () => {
    const older = chip({ anchor: { x: 300, y: 300 }, time: 1_000 });
    const newer = chip({ anchor: { x: 310, y: 305 }, time: 2_000 });
    const [olderPlaced, newerPlaced] = placeChips([older, newer], [], MAP);
    expect(newerPlaced?.side).toBe('right');
    expect(olderPlaced?.side).toBe('disc');
  });

  it('rule 3: my own chips (time Infinity) always win, and a disc never collapses further', () => {
    const mine = chip({ anchoring: 'centred', time: Infinity, collapsible: false });
    const theirs = chip({ anchor: { x: 290, y: 300 }, time: 5_000 });
    const lockDisc = chip({ anchor: { x: 300, y: 300 }, disc: true, time: 9_000 });
    const [minePlaced, theirsPlaced, discPlaced] = placeChips([mine, theirs, lockDisc], [], MAP);
    expect(minePlaced?.side).toBe('centre');
    expect(theirsPlaced?.side).toBe('disc');
    expect(discPlaced?.side).toBe('disc');
  });

  it('never leaves the visible map: a chip at the edge slides inward to 8 px', () => {
    // Right of an anchor near the bottom-right corner: both sides run off the bottom, so it slides up.
    const [placed] = placeChips([chip({ anchor: { x: 500, y: 695 } })], [], MAP);
    expect(placed?.side).toBe('right');
    expect(placed?.box.bottom).toBe(MAP.bottom - CHIP_EDGE_PX);
    // An anchor near the right edge flips left rather than sliding over its own anchor.
    const [nearRight] = placeChips([chip({ anchor: { x: 900, y: 300 } })], [], MAP);
    expect(nearRight?.side).toBe('left');
  });

  it('slideInward keeps the left/top edge when the box is wider than the map', () => {
    expect(slideInward({ left: -50, right: 1_100, top: 10, bottom: 34 }, MAP)).toEqual({
      left: CHIP_EDGE_PX,
      right: CHIP_EDGE_PX + 1_150,
      top: 10,
      bottom: 34,
    });
  });
});
