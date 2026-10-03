import { UsernameSchema } from '@snapland/shared';
import { describe, expect, it } from 'vitest';

import { canonicalUsername } from './username.js';

describe('canonicalUsername (one fold for the login counters and the account lookup)', () => {
  it('folds every ASCII case spelling of a name to the same lower-case value', () => {
    expect(canonicalUsername('Alice')).toBe('alice');
    expect(canonicalUsername('ALICE')).toBe('alice');
    expect(canonicalUsername('alice')).toBe('alice');
    expect(canonicalUsername('Ann_B.C-9')).toBe('ann_b.c-9');
  });

  it('accepts exactly the registration pattern (3 to 32 of A-Z a-z 0-9 _ . -)', () => {
    expect(canonicalUsername('abc')).toBe('abc');
    expect(canonicalUsername('a'.repeat(32))).toBe('a'.repeat(32));
    expect(canonicalUsername('ab')).toBeNull();
    expect(canonicalUsername('a'.repeat(33))).toBeNull();
    expect(canonicalUsername('')).toBeNull();
    expect(canonicalUsername('with space')).toBeNull();
    expect(canonicalUsername('semi;colon')).toBeNull();
  });

  it('accepts an email address and folds it to lower case (D-8)', () => {
    expect(canonicalUsername('Moshe.Peled@Example.com')).toBe('moshe.peled@example.com');
    expect(canonicalUsername('a+tag@sub.example.co.il')).toBe('a+tag@sub.example.co.il');
    expect(canonicalUsername('no-dot@localhost')).toBeNull();
    expect(canonicalUsername('two@@example.com')).toBeNull();
    expect(canonicalUsername('space @example.com')).toBeNull();
    expect(canonicalUsername(`${'a'.repeat(65)}@example.com`)).toBeNull();
    expect(canonicalUsername(`a@${'b'.repeat(130)}.com`)).toBeNull();
    expect(canonicalUsername('דנה@example.com')).toBeNull();
  });

  it.each([
    ['U+0130 (PostgreSQL folds it to i, JavaScript to i + U+0307)', 'alİce'],
    ['U+212A Kelvin sign (both fold it to k)', 'niKki'],
    ['U+0131 dotless i', 'alıce'],
    ['a fullwidth letter', 'alｉce'],
    ['a combining mark', 'ali̇ce'],
    ['U+0000 (PostgreSQL rejects it in text)', 'alice\u0000'],
    ['a lone U+0000', '\u0000'],
    ['a trailing newline', 'alice\n'],
    ['a leading newline', '\nalice'],
  ])('refuses %s: no account can have that name', (_label, raw) => {
    expect(canonicalUsername(raw)).toBeNull();
  });

  it('agrees with the shared UsernameSchema that registration uses', () => {
    const samples = [
      'alice',
      'Alice',
      'ab',
      'a'.repeat(33),
      'alİce',
      'x\u0000y',
      'o.k-_1',
      'Dana@Example.com',
      'x@y',
    ];
    for (const sample of samples) {
      expect(canonicalUsername(sample) !== null, sample).toBe(UsernameSchema.safeParse(sample).success);
    }
  });
});
