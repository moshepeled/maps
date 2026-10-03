import { describe, expect, it } from 'vitest';

import { REFRESH_RACE_WINDOW_MS, decideRotation, slidingExpiry } from './rotation.js';
import type { RefreshCandidate } from './rotation.js';

const NOW = new Date('2026-09-27T10:00:00.000Z');
const DAY_MS = 86_400_000;
const REFRESH_TTL_S = 14 * 86_400;

function candidate(overrides: Partial<RefreshCandidate> = {}): RefreshCandidate {
  return {
    matched: 'current',
    revoked: false,
    userDisabled: false,
    expiresAt: new Date(NOW.getTime() + DAY_MS),
    absoluteExpiresAt: new Date(NOW.getTime() + 20 * DAY_MS),
    rotatedAt: null,
    ...overrides,
  };
}

function ago(ms: number): Date {
  return new Date(NOW.getTime() - ms);
}

describe('slidingExpiry (section 6.2: sliding 14 d, absolute 30 d)', () => {
  it('extends to now + ttl while the absolute expiry is further away', () => {
    expect(slidingExpiry(NOW, REFRESH_TTL_S, new Date(NOW.getTime() + 30 * DAY_MS))).toEqual(
      new Date(NOW.getTime() + 14 * DAY_MS),
    );
  });

  it('never extends past the absolute expiry', () => {
    const absolute = new Date(NOW.getTime() + 3 * DAY_MS);
    expect(slidingExpiry(NOW, REFRESH_TTL_S, absolute)).toEqual(absolute);
  });
});

describe('decideRotation (section 6.2)', () => {
  it('rotates the current token of a live session with the sliding expiry', () => {
    expect(decideRotation(candidate(), NOW, REFRESH_TTL_S)).toEqual({
      kind: 'rotate',
      expiresAt: new Date(NOW.getTime() + 14 * DAY_MS),
    });
    const nearAbsolute = candidate({ absoluteExpiresAt: new Date(NOW.getTime() + 60_000) });
    expect(decideRotation(nearAbsolute, NOW, REFRESH_TTL_S)).toEqual({
      kind: 'rotate',
      expiresAt: nearAbsolute.absoluteExpiresAt,
    });
  });

  it('rejects a session past its sliding or absolute expiry (the boundary itself is expired)', () => {
    for (const expired of [
      candidate({ expiresAt: NOW }),
      candidate({ expiresAt: ago(1) }),
      candidate({ absoluteExpiresAt: NOW }),
    ]) {
      expect(decideRotation(expired, NOW, REFRESH_TTL_S)).toEqual({
        kind: 'reject',
        code: 'REFRESH_TOKEN_INVALID',
        reason: 'expired',
      });
    }
  });

  it('answers SESSION_REVOKED for a revoked session or a disabled user, whichever token matched', () => {
    for (const matched of ['current', 'previous'] as const) {
      expect(decideRotation(candidate({ matched, revoked: true }), NOW, REFRESH_TTL_S)).toEqual({
        kind: 'reject',
        code: 'SESSION_REVOKED',
        reason: 'revoked',
      });
      expect(decideRotation(candidate({ matched, userDisabled: true }), NOW, REFRESH_TTL_S)).toEqual({
        kind: 'reject',
        code: 'SESSION_REVOKED',
        reason: 'disabled',
      });
    }
  });

  it('treats the previous token within 10 s of the rotation as a parallel-tab race (<= 10 s inclusive)', () => {
    for (const elapsed of [0, 1, 5000, REFRESH_RACE_WINDOW_MS]) {
      expect(
        decideRotation(candidate({ matched: 'previous', rotatedAt: ago(elapsed) }), NOW, REFRESH_TTL_S),
      ).toEqual({ kind: 'reject', code: 'REFRESH_TOKEN_INVALID', reason: 'race' });
    }
  });

  it('detects reuse of the previous token more than 10 s after the rotation', () => {
    for (const elapsed of [REFRESH_RACE_WINDOW_MS + 1, 60_000, DAY_MS]) {
      expect(
        decideRotation(candidate({ matched: 'previous', rotatedAt: ago(elapsed) }), NOW, REFRESH_TTL_S),
      ).toEqual({ kind: 'reuse' });
    }
  });

  it('detects reuse of a previous token without a rotation time and on an expired session', () => {
    expect(decideRotation(candidate({ matched: 'previous', rotatedAt: null }), NOW, REFRESH_TTL_S)).toEqual({
      kind: 'reuse',
    });
    expect(
      decideRotation(
        candidate({ matched: 'previous', rotatedAt: ago(60_000), expiresAt: ago(1) }),
        NOW,
        REFRESH_TTL_S,
      ),
    ).toEqual({ kind: 'reuse' });
  });
});
