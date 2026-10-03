import { randomUUID } from 'node:crypto';

import { COLOR_PATTERN, USER_PALETTE } from '@snapland/shared';
import { describe, expect, it } from 'vitest';

import { colorForUser, fnv1a32 } from './palette.js';

describe('fnv1a32', () => {
  it('matches the reference FNV-1a 32-bit test vectors', () => {
    expect(fnv1a32('')).toBe(0x811c9dc5);
    expect(fnv1a32('a')).toBe(0xe40c292c);
    expect(fnv1a32('foobar')).toBe(0xbf9cf968);
  });

  it('hashes the UTF-8 bytes (non-ASCII input) and always returns an unsigned 32-bit integer', () => {
    const value = fnv1a32('שלום');
    expect(Number.isInteger(value)).toBe(true);
    expect(value).toBeGreaterThanOrEqual(0);
    expect(value).toBeLessThan(2 ** 32);
    expect(value).not.toBe(fnv1a32('shalom'));
  });
});

describe('colorForUser (section 6.2)', () => {
  it('is USER_PALETTE[fnv1a32(userId) mod 12]', () => {
    const userId = '3f6c1a2e-0b1d-4c55-9a0e-7c1d2b3a4f50';
    expect(colorForUser(userId)).toBe(USER_PALETTE[fnv1a32(userId) % 12]);
  });

  it('keeps every id on a fixed slot and maps slots to the D-6 colours (migration 0009 relies on slots never moving)', () => {
    // Golden vectors: if the hash or its input normalisation changed, stored colours would stop matching derived ones.
    expect(fnv1a32('3f6c1a2e-0b1d-4c55-9a0e-7c1d2b3a4f50') % 12).toBe(1);
    expect(fnv1a32('5a1f9c3e-7b2d-4e6f-8a1b-2c3d4e5f6a7b') % 12).toBe(10);
    expect(colorForUser('3f6c1a2e-0b1d-4c55-9a0e-7c1d2b3a4f50')).toBe('#f461ff');
    expect(colorForUser('5A1F9C3E-7B2D-4E6F-8A1B-2C3D4E5F6A7B')).toBe('#c44f9d');
  });

  it('is deterministic and case-insensitive for the same id', () => {
    const userId = randomUUID();
    expect(colorForUser(userId)).toBe(colorForUser(userId));
    expect(colorForUser(userId.toUpperCase())).toBe(colorForUser(userId));
  });

  it('always yields a palette colour in the users_color_ck format, spread over the palette', () => {
    const pattern = new RegExp(COLOR_PATTERN);
    const seen = new Set<string>();
    for (let i = 0; i < 500; i += 1) {
      const color = colorForUser(randomUUID());
      expect(USER_PALETTE).toContain(color);
      expect(color).toMatch(pattern);
      seen.add(color);
    }
    // 500 random ids leave a given colour unused with probability (11/12)^500 ~ 1e-19.
    expect(seen.size).toBe(USER_PALETTE.length);
  });
});
