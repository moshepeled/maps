import { describe, expect, it } from 'vitest';

import { createRefGenerator, isUuid, newId } from './ids';

describe('ids', () => {
  it('generates distinct UUIDv4 values', () => {
    const first = newId();
    const second = newId();
    expect(isUuid(first)).toBe(true);
    expect(first).not.toBe(second);
    expect(first[14]).toBe('4');
  });

  it('recognises UUIDs only', () => {
    expect(isUuid('4b0e1c2d-3e4f-4a5b-8c6d-7e8f9a0b1c2d')).toBe(true);
    expect(isUuid('not-a-uuid')).toBe(false);
    expect(isUuid(42)).toBe(false);
  });

  it('produces monotonic WebSocket refs', () => {
    const next = createRefGenerator();
    expect([next(), next(), next()]).toEqual(['c-1', 'c-2', 'c-3']);
    expect(createRefGenerator('r')()).toBe('r-1');
  });
});
