/**
 * Keyset cursor of `GET /admin/audit-logs` (SPEC section 6.4: keyset on `id DESC`). The cursor carries the last id of the
 * page and a fingerprint of the filters it was issued for, so a cursor replayed with other filters is refused
 * (400 INVALID_CURSOR) instead of silently skipping or repeating rows. Opaque base64url, <= 64 characters.
 */
import { createHash } from 'node:crypto';

import { BadRequestError } from '../../infra/http/errors.js';
import type { AuditLogFilters } from './admin.repository.js';

const FINGERPRINT_HEX_LENGTH = 16;
const CURSOR_PATTERN = /^([1-9]\d{0,15})\.([0-9a-f]{16})$/;

/** A stable digest of the filters (timestamps compared as instants, not as the client's spelling). */
export function filtersFingerprint(filters: AuditLogFilters): string {
  const canonical = JSON.stringify([
    filters.actorId,
    filters.action,
    filters.outcome,
    filters.from?.toISOString() ?? null,
    filters.to?.toISOString() ?? null,
  ]);
  return createHash('sha256').update(canonical).digest('hex').slice(0, FINGERPRINT_HEX_LENGTH);
}

export function encodeAuditCursor(lastId: number, filters: AuditLogFilters): string {
  return Buffer.from(`${lastId}.${filtersFingerprint(filters)}`, 'utf8').toString('base64url');
}

/** The id to continue below; throws 400 INVALID_CURSOR for anything this endpoint did not issue for these filters. */
export function decodeAuditCursor(cursor: string, filters: AuditLogFilters): number {
  const match = CURSOR_PATTERN.exec(Buffer.from(cursor, 'base64url').toString('utf8'));
  const id = Number(match?.[1]);
  if (match === null || !Number.isSafeInteger(id)) {
    throw new BadRequestError('INVALID_CURSOR', 'The cursor is malformed.');
  }
  if (match[2] !== filtersFingerprint(filters)) {
    throw new BadRequestError('INVALID_CURSOR', 'The cursor was issued for different filters.');
  }
  return id;
}
