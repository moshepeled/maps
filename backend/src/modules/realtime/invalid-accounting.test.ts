import { describe, expect, it } from 'vitest';

import { InvalidAccounting } from './invalid-accounting.js';

const OWNED_TTL_MS = 120_000;

function accounting(): InvalidAccounting {
  return new InvalidAccounting({ limit: 20, windowMs: 60_000, ownedMemory: 8, ownedTtlMs: OWNED_TTL_MS });
}

const foreignId = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

/** Whether a DRAFT_NOT_FOUND for `draftId` at `now` is exempt (a recently owned id). */
const exempt = (invalid: InvalidAccounting, draftId: string, now: number): boolean =>
  !invalid.recordDraftNotFound(draftId, now).counted;

describe('InvalidAccounting (section 7.6, section 7.8)', () => {
  it('closes on the 21st invalid message within 60 s', () => {
    const invalid = accounting();
    for (let i = 0; i < 20; i += 1) expect(invalid.recordInvalid(i * 100)).toBe(false);
    expect(invalid.recordInvalid(2100)).toBe(true);
    expect(invalid.total).toBe(21);
  });

  it('does not close when the invalid messages are spread over more than the window', () => {
    const invalid = accounting();
    for (let i = 0; i < 40; i += 1) expect(invalid.recordInvalid(i * 5000)).toBe(false);
  });

  it('counts DRAFT_NOT_FOUND for ids the connection never owned: the 21st foreign id closes', () => {
    const invalid = accounting();
    for (let i = 0; i < 20; i += 1) {
      expect(invalid.recordDraftNotFound(foreignId(i), i)).toEqual({ counted: true, close: false });
    }
    expect(invalid.recordDraftNotFound(foreignId(20), 20)).toEqual({ counted: true, close: true });
  });

  it('never counts DRAFT_NOT_FOUND for a recently owned id (own late updates after an expiry)', () => {
    const invalid = accounting();
    invalid.rememberOwned('own-draft', 0);
    for (let i = 0; i < 25; i += 1) {
      expect(invalid.recordDraftNotFound('own-draft', 1000 + i)).toEqual({ counted: false, close: false });
    }
    expect(invalid.total).toBe(0);
  });

  it('remembers only the last 8 owned ids', () => {
    const invalid = accounting();
    for (let i = 0; i < 9; i += 1) invalid.rememberOwned(foreignId(i), i);
    expect(exempt(invalid, foreignId(0), 10)).toBe(false);
    for (let i = 1; i < 9; i += 1) expect(exempt(invalid, foreignId(i), 10)).toBe(true);
  });

  it('re-remembering an id refreshes it (moves it to the newest slot, new expiry)', () => {
    const invalid = accounting();
    invalid.rememberOwned(foreignId(0), 0);
    for (let i = 1; i < 8; i += 1) invalid.rememberOwned(foreignId(i), i);
    invalid.rememberOwned(foreignId(0), 100);
    invalid.rememberOwned(foreignId(8), 101);
    expect(exempt(invalid, foreignId(0), OWNED_TTL_MS + 50)).toBe(true);
    expect(exempt(invalid, foreignId(1), 200)).toBe(false);
  });

  it('counts a formerly owned id again once the resume window has passed', () => {
    const invalid = accounting();
    invalid.rememberOwned('old-draft', 0);
    expect(exempt(invalid, 'old-draft', OWNED_TTL_MS - 1)).toBe(true);
    expect(exempt(invalid, 'old-draft', OWNED_TTL_MS)).toBe(false);
  });
});
