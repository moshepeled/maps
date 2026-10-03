/**
 * Boundary normalisation of audit events (SPEC section 10.4): `details` <= 4 KiB of JSON text (else replaced by
 * `{ truncated: true, keys }`), user agent <= 512 code points, U+0000 removed from free text, timestamp defaulted.
 * Shared by every AuditLogger so a poison value can never reach the batch insert.
 */
import { truncateCodePoints } from '@snapland/shared';

import type { AuditEvent } from './types.js';

export const AUDIT_DETAILS_MAX_BYTES = 4096;
export const AUDIT_USER_AGENT_MAX_CODE_POINTS = 512;

export type NormalizedAuditEvent = Required<Omit<AuditEvent, 'details' | 'occurredAt'>> & {
  details: Record<string, unknown>;
  occurredAt: Date;
};

// PostgreSQL text refuses U+0000 (22021) and jsonb refuses its escape `\u0000` (22P05): one such character would get
// the whole row rejected, and an attacker could make their own refused requests vanish from the trail.
const NUL = '\u0000';

function withoutNul(text: string | null | undefined): string | null {
  return text === undefined || text === null ? null : text.replaceAll(NUL, '');
}

/** `details` with U+0000 removed from every string value; copied (through JSON) only when one is present. */
function detailsWithoutNul(details: Record<string, unknown>): Record<string, unknown> {
  if (!JSON.stringify(details).includes('\\u0000')) return details;
  const text = JSON.stringify(details, (_key, value: unknown) =>
    typeof value === 'string' ? withoutNul(value) : value,
  );
  return JSON.parse(text) as Record<string, unknown>;
}

function normalizeDetails(details: Record<string, unknown> | undefined): Record<string, unknown> {
  if (details === undefined) return {};
  const clean = detailsWithoutNul(details);
  if (Buffer.byteLength(JSON.stringify(clean)) <= AUDIT_DETAILS_MAX_BYTES) return clean;
  return { truncated: true, keys: Object.keys(clean).slice(0, 50) };
}

export function normalizeAuditEvent(event: AuditEvent, now: number): NormalizedAuditEvent {
  const userAgent = withoutNul(event.userAgent);
  return {
    action: event.action,
    outcome: event.outcome,
    actorId: event.actorId ?? null,
    sessionId: event.sessionId ?? null,
    targetType: event.targetType ?? null,
    targetId: withoutNul(event.targetId),
    requestId: withoutNul(event.requestId),
    ip: event.ip ?? null,
    userAgent: userAgent === null ? null : truncateCodePoints(userAgent, AUDIT_USER_AGENT_MAX_CODE_POINTS),
    details: normalizeDetails(event.details),
    occurredAt: event.occurredAt ?? new Date(now),
  };
}
