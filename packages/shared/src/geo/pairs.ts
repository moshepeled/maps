/** Consecutive pairs of a sequence: `[a, b, c]` -> `[[a, b, 0], [b, c, 1]]` (the edges of a closed ring). */
export function consecutivePairs<T>(items: readonly T[]): [T, T, number][] {
  const pairs: [T, T, number][] = [];
  items.forEach((item, index) => {
    const next = items[index + 1];
    if (next !== undefined) pairs.push([item, next, index]);
  });
  return pairs;
}
