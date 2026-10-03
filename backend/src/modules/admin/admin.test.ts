import { describe, expect, it } from 'vitest';

import { AppError } from '../../infra/http/errors.js';
import { conflictRate, toAuditLogDto } from './admin.mapper.js';
import type { AuditLogFilters, AuditLogRow } from './admin.repository.js';
import { decodeAuditCursor, encodeAuditCursor, filtersFingerprint } from './audit-cursor.js';
import { DEFAULT_STATS_WINDOW_MS, MAX_STATS_WINDOW_MS, resolveStatsWindow } from './stats-window.js';

const NO_FILTERS: AuditLogFilters = { actorId: null, action: null, outcome: null, from: null, to: null };

function codeOf(action: () => unknown): string {
  try {
    action();
  } catch (error) {
    if (error instanceof AppError) return error.code;
    throw error;
  }
  throw new Error('expected an AppError');
}

function row(id: number): AuditLogRow {
  return {
    id,
    occurred_at: new Date(Date.UTC(2026, 8, 27, 10, 0, 0) + id),
    action: 'area.create',
    outcome: 'success',
    actor_id: null,
    session_id: null,
    target_type: 'area',
    target_id: `a-${id}`,
    request_id: null,
    instance_id: 'i-1',
    ip: null,
    user_agent: null,
    details: { version: 1 },
  };
}

describe('audit-logs keyset cursor', () => {
  it('round-trips the last id for the same filters', () => {
    const filters = { ...NO_FILTERS, action: 'area.create' };
    const cursor = encodeAuditCursor(123_456, filters);
    expect(cursor).toMatch(/^[A-Za-z0-9_-]{1,64}$/);
    expect(decodeAuditCursor(cursor, filters)).toBe(123_456);
  });

  it('compares timestamps as instants, not as the client spelled them', () => {
    const a = { ...NO_FILTERS, from: new Date('2026-09-27T10:00:00Z') };
    const b = { ...NO_FILTERS, from: new Date('2026-09-27T13:00:00+03:00') };
    expect(filtersFingerprint(a)).toBe(filtersFingerprint(b));
  });

  it('refuses a cursor issued for other filters, or anything malformed, with 400 INVALID_CURSOR', () => {
    const cursor = encodeAuditCursor(10, NO_FILTERS);
    expect(codeOf(() => decodeAuditCursor(cursor, { ...NO_FILTERS, outcome: 'denied' }))).toBe(
      'INVALID_CURSOR',
    );
    for (const bad of ['', 'xyz', Buffer.from('0.0000000000000000').toString('base64url'), '!!!']) {
      expect(codeOf(() => decodeAuditCursor(bad, NO_FILTERS))).toBe('INVALID_CURSOR');
    }
  });
});

describe('audit-stats window', () => {
  const now = Date.UTC(2026, 8, 27, 12);

  it('defaults to the last 24 h', () => {
    const window = resolveStatsWindow({}, now);
    expect(window.to.getTime()).toBe(now);
    expect(window.to.getTime() - window.from.getTime()).toBe(DEFAULT_STATS_WINDOW_MS);
  });

  it('accepts exactly 31 days and refuses more, or an empty/inverted window', () => {
    const to = new Date(now).toISOString();
    const from31 = new Date(now - MAX_STATS_WINDOW_MS).toISOString();
    expect(resolveStatsWindow({ from: from31, to }, now).from.toISOString()).toBe(from31);
    expect(
      codeOf(() =>
        resolveStatsWindow({ from: new Date(now - MAX_STATS_WINDOW_MS - 1).toISOString(), to }, now),
      ),
    ).toBe('VALIDATION_FAILED');
    expect(codeOf(() => resolveStatsWindow({ from: to, to }, now))).toBe('VALIDATION_FAILED');
    expect(codeOf(() => resolveStatsWindow({ from: new Date(now + 1).toISOString(), to }, now))).toBe(
      'VALIDATION_FAILED',
    );
  });
});

describe('admin mapping', () => {
  it('maps a row to the DTO with ISO timestamps', () => {
    expect(toAuditLogDto(row(7))).toMatchObject({
      id: 7,
      occurredAt: '2026-09-27T10:00:00.007Z',
      targetId: 'a-7',
    });
  });

  it('computes the conflict rate over update attempts (0 when there were none)', () => {
    expect(conflictRate(3, 1)).toBe(0.25);
    expect(conflictRate(0, 0)).toBe(0);
    expect(conflictRate(0, 2)).toBe(1);
  });
});
