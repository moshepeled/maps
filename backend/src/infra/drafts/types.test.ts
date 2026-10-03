import { describe, expect, it } from 'vitest';

import { draftTouchIntervalMs } from './types.js';

describe('draftTouchIntervalMs (section 7.6)', () => {
  it('derives the touch throttle from the resume window: 10 s, or a third of a shorter window', () => {
    expect(draftTouchIntervalMs(120)).toBe(10_000);
    expect(draftTouchIntervalMs(30)).toBe(10_000);
    expect(draftTouchIntervalMs(2)).toBe(666);
    expect(draftTouchIntervalMs(1)).toBe(333);
  });
});
