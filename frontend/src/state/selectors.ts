/**
 * Pure selectors over the stores (SPEC section 8.5 "Analysis", UX C-10, C-26). Areas are "in view" when their bbox
 * intersects the viewport - the same rule the server uses for bbox queries - so the list, the summary and the
 * E2E hook always agree.
 */
import type { Bbox, UserRef } from '@snapland/shared';
import { bboxesIntersect } from '@snapland/shared';

import type { AreaRecord } from './areasStore';

export interface ViewportSummary {
  count: number;
  /** Sum of the stored `areaKm2` (overlapping areas are each counted). */
  totalKm2: number;
}

/** Does any loaded area intersect the viewport? Stops at the first hit (the empty-view check, UX C-17). */
export function hasAreaInView(areas: Iterable<AreaRecord>, viewport: Bbox | null): boolean {
  if (viewport === null) return false;
  for (const area of areas) {
    if (bboxesIntersect(area.bbox, viewport)) return true;
  }
  return false;
}

export function areasInView(areas: Iterable<AreaRecord>, viewport: Bbox | null): AreaRecord[] {
  if (viewport === null) return [];
  const result: AreaRecord[] = [];
  for (const area of areas) {
    if (bboxesIntersect(area.bbox, viewport)) result.push(area);
  }
  return result;
}

/** `analysis-summary`: loaded live areas intersecting the viewport and their total km² (SPEC section 8.5). */
export function viewportSummary(areas: Iterable<AreaRecord>, viewport: Bbox | null): ViewportSummary {
  let count = 0;
  let totalKm2 = 0;
  for (const area of areasInView(areas, viewport)) {
    count += 1;
    totalKm2 += area.areaKm2;
  }
  return { count, totalKm2 };
}

export type AreaSort = 'recent' | 'name' | 'size';

const nameCollator = new Intl.Collator(undefined, { sensitivity: 'base' });

/** Case- and diacritic-insensitive substring match (UX C-10 filter). */
export function matchesFilter(name: string, query: string): boolean {
  const normalise = (value: string): string =>
    value.normalize('NFD').replace(/\p{M}/gu, '').toLocaleLowerCase();
  const needle = normalise(query.trim());
  return needle === '' || normalise(name).includes(needle);
}

/** The Areas list order (UX C-10): recently edited (default), name (locale-aware), size (largest first). */
export function sortAreas(areas: readonly AreaRecord[], sort: AreaSort): AreaRecord[] {
  const copy = [...areas];
  switch (sort) {
    case 'recent':
      return copy.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
    case 'name':
      return copy.sort((left, right) => nameCollator.compare(left.name, right.name));
    case 'size':
      return copy.sort((left, right) => right.areaKm2 - left.areaKm2);
  }
}

/** The rows of the Areas list, in order (UX C-10): live areas in view that match the filter, sorted. */
export function listedAreas(
  areas: Iterable<AreaRecord>,
  hidden: ReadonlySet<string>,
  viewport: Bbox | null,
  filter: string,
  sort: AreaSort,
): AreaRecord[] {
  const visible = [...areas].filter((area) => !hidden.has(area.id));
  return sortAreas(
    areasInView(visible, viewport).filter((area) => matchesFilter(area.name, filter)),
    sort,
  );
}

export interface Viewer {
  id: string;
  role: 'user' | 'admin';
}

/** `canDelete = canRestore` (UX section 0, SPEC section 8.6): the creator or an admin, decided from `createdById` if needed. */
export function canDelete(
  viewer: Viewer | null,
  area: { createdBy?: UserRef | null; createdById: string },
): boolean {
  if (viewer === null) return false;
  if (viewer.role === 'admin') return true;
  return viewer.id === (area.createdBy?.id ?? area.createdById);
}

/** Canvas draw order (UX section 3.3): larger areas first so smaller, nested ones stay on top and clickable. */
export function drawOrder(areas: readonly AreaRecord[]): AreaRecord[] {
  return [...areas].sort((left, right) => right.areaKm2 - left.areaKm2 || left.id.localeCompare(right.id));
}
