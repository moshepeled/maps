import { describe, expect, it } from 'vitest';

import { AUDIT_DETAILS_MAX_BYTES, normalizeAuditEvent } from './normalize.js';

const NUL = String.fromCodePoint(0);

describe('normalizeAuditEvent (section 10.4)', () => {
  it('removes U+0000 from free text (PostgreSQL would reject the whole row with 22021 / 22P05)', () => {
    const normalized = normalizeAuditEvent(
      {
        action: 'area.update',
        outcome: 'failure',
        targetId: `a${NUL}'; DROP TABLE users; --`,
        requestId: `r${NUL}1`,
        userAgent: `ua${NUL}`,
        details: { code: `X${NUL}`, nested: { list: [`b${NUL}`, 1] } },
      },
      0,
    );
    expect(normalized).toMatchObject({
      targetId: "a'; DROP TABLE users; --",
      requestId: 'r1',
      userAgent: 'ua',
      details: { code: 'X', nested: { list: ['b', 1] } },
    });
  });

  it('keeps clean details as the same object and defaults absent fields', () => {
    const details = { code: 'VALIDATION_FAILED', status: 400 };
    const normalized = normalizeAuditEvent({ action: 'area.update', outcome: 'failure', details }, 5);
    expect(normalized.details).toBe(details);
    expect(normalized).toMatchObject({
      targetId: null,
      requestId: null,
      userAgent: null,
      occurredAt: new Date(5),
    });
    expect(normalizeAuditEvent({ action: 'area.update', outcome: 'failure' }, 0).details).toEqual({});
  });

  it('replaces over-long details by their keys', () => {
    const normalized = normalizeAuditEvent(
      { action: 'area.update', outcome: 'failure', details: { blob: 'x'.repeat(AUDIT_DETAILS_MAX_BYTES) } },
      0,
    );
    expect(normalized.details).toEqual({ truncated: true, keys: ['blob'] });
  });
});
