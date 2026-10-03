import { describe, expect, it } from 'vitest';

import {
  displayName,
  displayUser,
  graphemes,
  initials,
  sanitized,
  sanitizedLength,
  truncateGraphemes,
} from './text';

describe('UX section 9.14 truncation and initials', () => {
  it('truncates by grapheme with an ellipsis and trims trailing whitespace', () => {
    expect(truncateGraphemes('North Field', 20)).toBe('North Field');
    expect(truncateGraphemes('North Field West', 6)).toBe('North…');
    expect(displayName('x'.repeat(40))).toBe(`${'x'.repeat(32)}…`);
    expect(displayUser('y'.repeat(25))).toBe(`${'y'.repeat(20)}…`);
  });

  it('never splits a Hebrew letter with niqqud or an emoji', () => {
    const niqqud = 'שָׁלוֹם';
    expect(graphemes(niqqud).length).toBeLessThan(niqqud.length);
    expect(truncateGraphemes(`${niqqud}${niqqud}`, graphemes(niqqud).length)).toBe(`${niqqud}…`);
    expect(truncateGraphemes('👩‍👩‍👧‍👦abc', 1)).toBe('👩‍👩‍👧‍👦…');
  });

  it('initials: two words -> two initials, one word -> two letters', () => {
    expect(initials('Dana Levi')).toBe('DL');
    expect(initials('moshe')).toBe('Mo');
    expect(initials('משה כהן')).toBe('מכ');
    expect(initials('   ')).toBe('?');
  });

  it('counts code points after sanitising like the server', () => {
    expect(sanitized('  a​b  ')).toBe('ab');
    expect(sanitizedLength('​​')).toBe(0);
    expect(sanitizedLength('a\nb', true)).toBe(3);
  });
});
