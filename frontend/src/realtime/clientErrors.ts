/**
 * Reports protocol bugs and crashes to `POST /api/v1/client-errors` (SPEC section 3.6, section 6.4): WS closes 1003/1009/4400,
 * schema-invalid server messages, unhandled exceptions. Deduplicated (same kind + code + message once per minute)
 * and capped at 10 reports a minute, so a broken server can never make every client flood the endpoint.
 */
import type { ClientErrorReport } from '@snapland/shared';
import { LIMITS } from '@snapland/shared';

import type { Scheduler } from '../lib/scheduler';

export const CLIENT_ERROR_MAX_PER_MINUTE = 10;
const WINDOW_MS = 60_000;
const DEDUPE_MAX_KEYS = 200;

export type ClientErrorInput = Omit<ClientErrorReport, 'appVersion'>;

export interface ClientErrorReporterDeps {
  scheduler: Scheduler;
  appVersion: string;
  post(report: ClientErrorReport): Promise<void>;
}

export class ClientErrorReporter {
  private readonly sentAt: number[] = [];
  private readonly lastByKey = new Map<string, number>();

  constructor(private readonly deps: ClientErrorReporterDeps) {}

  /** Queues a report; returns whether it was sent (false when deduplicated or over the cap). */
  report(input: ClientErrorInput): boolean {
    const now = this.deps.scheduler.now();
    const message = input.message.slice(0, LIMITS.clientErrorMessageMaxLength);
    const key = `${input.kind}|${String(input.code ?? '')}|${message}`;
    const last = this.lastByKey.get(key);
    if (last !== undefined && now - last < WINDOW_MS) return false;
    while (this.sentAt.length > 0 && now - (this.sentAt[0] ?? now) >= WINDOW_MS) this.sentAt.shift();
    if (this.sentAt.length >= CLIENT_ERROR_MAX_PER_MINUTE) return false;
    this.sentAt.push(now);
    this.lastByKey.set(key, now);
    if (this.lastByKey.size > DEDUPE_MAX_KEYS) {
      const oldest = this.lastByKey.keys().next();
      if (oldest.done !== true) this.lastByKey.delete(oldest.value);
    }
    const report: ClientErrorReport = { ...input, message, appVersion: this.deps.appVersion };
    // Reporting must never become an error source itself.
    this.deps.post(report).catch(() => undefined);
    return true;
  }
}
