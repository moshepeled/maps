/**
 * The time window of `GET /admin/audit-stats` (SPEC section 6.4): default the last 24 h, `from < to`, at most 31 days - the
 * bound that keeps every aggregate a bounded BRIN range scan.
 */
import { LIMITS } from '@snapland/shared';

import { ValidationError } from '../../infra/http/errors.js';

export const DEFAULT_STATS_WINDOW_MS = 24 * 60 * 60 * 1000;
export const MAX_STATS_WINDOW_MS = LIMITS.auditStatsMaxWindowDays * 24 * 60 * 60 * 1000;

export interface StatsWindow {
  from: Date;
  to: Date;
}

export function resolveStatsWindow(query: { from?: string; to?: string }, now: number): StatsWindow {
  const to = query.to === undefined ? new Date(now) : new Date(query.to);
  const from =
    query.from === undefined ? new Date(to.getTime() - DEFAULT_STATS_WINDOW_MS) : new Date(query.from);
  if (from.getTime() >= to.getTime()) {
    throw new ValidationError('The window is empty: `from` must be before `to`.', [
      { path: 'query.from', code: 'invalid_window', message: 'must be before to' },
    ]);
  }
  if (to.getTime() - from.getTime() > MAX_STATS_WINDOW_MS) {
    throw new ValidationError(`The window must not exceed ${LIMITS.auditStatsMaxWindowDays} days.`, [
      {
        path: 'query.from',
        code: 'window_too_large',
        message: `at most ${LIMITS.auditStatsMaxWindowDays} days before to`,
      },
    ]);
  }
  return { from, to };
}
