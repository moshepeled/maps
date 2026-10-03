import { describe, expect, it } from 'vitest';

import { cutPage } from './page-budget.js';

interface Row {
  id: string;
  geometry: string | null;
}

/**
 * Rows as `findInBbox` returns them for the given vertex counts and budget: geometry on the first row and on every
 * row whose running sum fits the budget (the SQL's `rn = 1 OR cum_positions <= budget`), none on the sentinel.
 */
function rows(vertexCounts: readonly number[], budget = 100): Row[] {
  let cum = 0;
  return vertexCounts.map((count, index) => {
    cum += count;
    return { id: `a${index + 1}`, geometry: index === 0 || cum <= budget ? 'polygon' : null };
  });
}

const ids = (items: readonly Row[]): string[] => items.map((item) => item.id);

describe('cutPage (section 5.5 page position budget)', () => {
  it('returns every row and no continuation when all fit and the limit is not exceeded', () => {
    expect(cutPage(rows([4, 4, 4]), 10)).toEqual({
      items: rows([4, 4, 4]),
      hasMore: false,
      cutByBudget: false,
    });
  });

  it('treats the limit + 1 row as the continuation marker', () => {
    const page = cutPage(rows([4, 4, 4]), 2);
    expect(ids(page.items)).toEqual(['a1', 'a2']);
    expect(page.hasMore).toBe(true);
    expect(page.cutByBudget).toBe(false);
  });

  it('drops the budget sentinel row and keeps a continuation', () => {
    // 40 + 40 = 80 <= 100; the third row (cum 120) is the sentinel past the budget.
    const page = cutPage(rows([40, 40, 40]), 10);
    expect(ids(page.items)).toEqual(['a1', 'a2']);
    expect(page.hasMore).toBe(true);
    expect(page.cutByBudget).toBe(true);
  });

  it('keeps a row whose running sum equals the budget exactly', () => {
    const page = cutPage(rows([50, 50, 1]), 10);
    expect(ids(page.items)).toEqual(['a1', 'a2']);
    expect(page.hasMore).toBe(true);
    expect(page.cutByBudget).toBe(true);
  });

  it('always keeps the first row, even when it alone exceeds the budget', () => {
    const page = cutPage(rows([150, 10]), 10);
    expect(ids(page.items)).toEqual(['a1']);
    expect(page.hasMore).toBe(true);
    expect(page.cutByBudget).toBe(true);
  });

  it('does not count a page as budget-cut when the limit was reached first', () => {
    const page = cutPage(rows([40, 40, 40]), 2);
    expect(ids(page.items)).toEqual(['a1', 'a2']);
    expect(page.hasMore).toBe(true);
    expect(page.cutByBudget).toBe(false);
  });

  it('returns an empty page for no rows', () => {
    expect(cutPage([], 10)).toEqual({ items: [], hasMore: false, cutByBudget: false });
  });
});
