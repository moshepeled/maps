import type { ClientErrorReport } from '@snapland/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { systemScheduler } from '../lib/scheduler';
import { CLIENT_ERROR_MAX_PER_MINUTE, ClientErrorReporter } from './clientErrors';

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe('ClientErrorReporter (SPEC section 6.4 client-errors)', () => {
  it('deduplicates identical reports for a minute and caps at 10 a minute', () => {
    const posted: ClientErrorReport[] = [];
    const reporter = new ClientErrorReporter({
      scheduler: systemScheduler,
      appVersion: '1.0.0',
      post: (report) => {
        posted.push(report);
        return Promise.resolve();
      },
    });
    expect(reporter.report({ kind: 'ws_close', code: 1003, message: 'binary' })).toBe(true);
    expect(reporter.report({ kind: 'ws_close', code: 1003, message: 'binary' })).toBe(false);
    for (let i = 0; i < 20; i += 1) reporter.report({ kind: 'ws_schema', message: `bad ${i}` });
    expect(posted).toHaveLength(CLIENT_ERROR_MAX_PER_MINUTE);
    expect(posted[0]).toEqual({ kind: 'ws_close', code: 1003, message: 'binary', appVersion: '1.0.0' });
    vi.advanceTimersByTime(60_000);
    expect(reporter.report({ kind: 'ws_close', code: 1003, message: 'binary' })).toBe(true);
  });

  it('truncates long messages and never throws when posting fails', async () => {
    const reporter = new ClientErrorReporter({
      scheduler: systemScheduler,
      appVersion: '1.0.0',
      post: () => Promise.reject(new Error('down')),
    });
    expect(reporter.report({ kind: 'unhandled', message: 'x'.repeat(900) })).toBe(true);
    await vi.advanceTimersByTimeAsync(0);
  });
});
