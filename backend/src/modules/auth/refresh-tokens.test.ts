import { createHash } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import {
  REFRESH_COOKIE_PATH,
  generateRefreshToken,
  isWellFormedRefreshToken,
  refreshCookieMaxAgeS,
  refreshCookieOptions,
} from './refresh-tokens.js';

describe('refresh tokens (section 6.2)', () => {
  it('are 32 random bytes as 43 base64url characters, paired with their SHA-256', () => {
    const { token, hash } = generateRefreshToken();
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(hash).toEqual(createHash('sha256').update(token).digest());
    expect(hash).toHaveLength(32);
    expect(generateRefreshToken().token).not.toBe(token);
  });

  it('accepts only the shape of a token we issue', () => {
    expect(isWellFormedRefreshToken(generateRefreshToken().token)).toBe(true);
    for (const value of ['', 'short', 'a'.repeat(44), `${'a'.repeat(42)}=`, `${'a'.repeat(42)}+`]) {
      expect(isWellFormedRefreshToken(value)).toBe(false);
    }
  });
});

describe('refresh cookie attributes (section 6.2)', () => {
  it('is HttpOnly, SameSite=Strict, scoped to /api/v1/auth, Secure unless disabled', () => {
    expect(refreshCookieOptions(true, 1_209_600)).toEqual({
      httpOnly: true,
      secure: true,
      sameSite: 'strict',
      path: REFRESH_COOKIE_PATH,
      maxAge: 1_209_600,
    });
    expect(refreshCookieOptions(false)).toEqual({
      httpOnly: true,
      secure: false,
      sameSite: 'strict',
      path: '/api/v1/auth',
    });
  });

  it('lives as long as the session (never negative)', () => {
    const now = new Date('2026-09-27T10:00:00.000Z');
    expect(refreshCookieMaxAgeS(new Date(now.getTime() + 1_209_600_000), now)).toBe(1_209_600);
    expect(refreshCookieMaxAgeS(new Date(now.getTime() - 5000), now)).toBe(0);
  });
});
