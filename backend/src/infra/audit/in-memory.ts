/**
 * In-memory audit logger (SPEC section 3.3): keeps normalised events in a bounded array and logs each one at `info` with
 * `audit: true` (the second trail). Tests assert on `events`; the production writer is the BufferedAuditWriter.
 */
import type { Clock } from '../clock.js';
import type { Logger } from '../logger.js';
import { normalizeAuditEvent } from './normalize.js';
import type { NormalizedAuditEvent } from './normalize.js';
import type { AuditEvent, AuditLogger } from './types.js';

/** Events kept at most (oldest dropped). */
const CAPACITY = 10_000;

export interface InMemoryAuditLoggerDeps {
  clock: Clock;
  logger: Logger;
}

export class InMemoryAuditLogger implements AuditLogger {
  readonly events: NormalizedAuditEvent[] = [];
  readonly #clock: Clock;
  readonly #logger: Logger;

  constructor({ clock, logger }: InMemoryAuditLoggerDeps) {
    this.#clock = clock;
    this.#logger = logger.child({ component: 'audit' });
  }

  record(event: AuditEvent): void {
    try {
      const normalized = normalizeAuditEvent(event, this.#clock.now());
      this.events.push(normalized);
      if (this.events.length > CAPACITY) this.events.shift();
      this.#logger.info({ audit: true, ...normalized }, `audit ${normalized.action} ${normalized.outcome}`);
    } catch (error) {
      // record() must never throw into the request path.
      this.#logger.error({ err: error, action: event.action }, 'audit event could not be recorded');
    }
  }

  flush(): Promise<void> {
    return Promise.resolve();
  }

  /** Events matching a partial shape (test convenience). */
  find(predicate: (event: NormalizedAuditEvent) => boolean): NormalizedAuditEvent[] {
    return this.events.filter(predicate);
  }

  clear(): void {
    this.events.length = 0;
  }
}
