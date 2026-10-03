/**
 * Interest management (SPEC section 7.8): a connection's interest region is its viewport expanded by 50 % of the width and
 * height on each side (clamped to the displayable world). Spatial events are delivered only to connections whose
 * interest intersects one of the event's boxes. The scan over local connections is linear (~ 4 comparisons each); an
 * R-tree is the documented upgrade beyond ~10k connections per instance.
 */
import { bboxesIntersect, expandBbox } from '@snapland/shared';
import type { Bbox } from '@snapland/shared';

/** Margin added on every side of the viewport, as a fraction of its width/height. */
export const INTEREST_MARGIN = 0.5;

export function interestOf(viewportBbox: Bbox): Bbox {
  return expandBbox(viewportBbox, INTEREST_MARGIN);
}

/**
 * True when `interest` intersects at least one non-null target box. A connection without a viewport (null interest)
 * receives no spatial events; a null target (e.g. an area without a previous bbox) is skipped.
 */
export function intersectsInterest(interest: Bbox | null, targets: readonly (Bbox | null)[]): boolean {
  if (interest === null) return false;
  return targets.some((target) => target !== null && bboxesIntersect(interest, target));
}
