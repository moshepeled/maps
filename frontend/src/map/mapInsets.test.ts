/** Runtime map insets (UI.md section 4.4) and the overlay inspector's "pan the shape out from under it" (UX section 3.2). */
import { describe, expect, it } from 'vitest';

import { NO_INSETS, panIntoFreeArea, readMapInsets } from './mapInsets';

function style(values: Record<string, string>) {
  return { getPropertyValue: (name: string) => values[name] ?? '' };
}

describe('readMapInsets', () => {
  it('reads the px custom properties; the attribution counts at the bottom', () => {
    expect(
      readMapInsets(
        style({
          '--map-inset-right': '360px',
          '--map-inset-bottom': ' 120px',
          '--map-attribution-h': '20px',
        }),
      ),
    ).toEqual({ top: 0, right: 360, bottom: 140, left: 0 });
  });

  it('missing, unparsable or negative values count as 0', () => {
    expect(
      readMapInsets(style({ '--map-inset-right': 'calc(1px + 2px)', '--map-inset-top': '-4px' })),
    ).toEqual(NO_INSETS);
  });
});

describe('panIntoFreeArea', () => {
  const size = { x: 1000, y: 700 };
  const overlay = { top: 0, right: 360, bottom: 20, left: 0 };

  it('UX-AC-121 pans a shape out from under the overlay inspector (map moves left: positive dx)', () => {
    expect(panIntoFreeArea({ left: 900, top: 300, right: 960, bottom: 340 }, size, overlay, 16)).toEqual({
      dx: 960 - (1000 - 360 - 16),
      dy: 0,
    });
  });

  it('does nothing when the shape is already in the free area', () => {
    expect(panIntoFreeArea({ left: 100, top: 100, right: 300, bottom: 300 }, size, overlay, 16)).toBeNull();
  });

  it('pans down for a shape above the top, and reports a shape that cannot fit', () => {
    expect(panIntoFreeArea({ left: 100, top: -50, right: 200, bottom: 50 }, size, NO_INSETS, 16)).toEqual({
      dx: 0,
      dy: -66,
    });
    expect(panIntoFreeArea({ left: 0, top: 0, right: 700, bottom: 100 }, size, overlay, 16)).toBe(
      'too-large',
    );
  });
});
