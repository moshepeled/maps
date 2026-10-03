/**
 * The page position budget of the bbox list (SPEC section 5.5, `LIMITS.bboxPagePositionBudget`). `areas.findInBbox` returns,
 * in id order, the rows whose running sum of stored positions fits the budget (each with its geometry) plus ONE
 * sentinel row past it (without geometry), or the `limit + 1` row. This pure step decides which rows become items and
 * whether another page exists, so a page is bounded in rows AND bytes while the union of all pages stays the full
 * result set.
 */

/** A row inside the budget carries its geometry; the sentinel past it has none. */
type WithGeometry<T extends { geometry: unknown }> = T & { geometry: NonNullable<T['geometry']> };

export interface BudgetedPage<T> {
  items: T[];
  /** More rows exist after the last item (the limit+1 row or the budget sentinel was returned). */
  hasMore: boolean;
  /** The page holds fewer than `limit` items because of the budget (counted by `snapland_area_bbox_page_budget_cuts_total`). */
  cutByBudget: boolean;
}

/** items = the rows with geometry, at most `limit` of them; hasMore = rows beyond the items exist. */
export function cutPage<T extends { geometry: unknown }>(
  rows: readonly T[],
  limit: number,
): BudgetedPage<WithGeometry<T>> {
  const withGeometry = rows.filter((row): row is WithGeometry<T> => row.geometry !== null);
  const items = withGeometry.slice(0, limit);
  return {
    items,
    hasMore: rows.length > items.length,
    cutByBudget: rows.length > withGeometry.length && items.length < limit,
  };
}
