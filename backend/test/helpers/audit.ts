/** In-memory audit logger for tests that assert on audit events (SPEC section 3.3: inject, never rely on index.ts). */
import { pino } from 'pino';

import { InMemoryAuditLogger } from '../../src/infra/audit/in-memory.js';
import { systemClock } from '../../src/infra/clock.js';

export function createMemoryAudit(): InMemoryAuditLogger {
  return new InMemoryAuditLogger({ clock: systemClock, logger: pino({ level: 'silent' }) });
}
