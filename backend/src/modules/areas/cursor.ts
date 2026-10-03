/**
 * Opaque pagination cursors (SPEC section 5.5 step 4, section 6.3). A bbox cursor is `base64url(JSON {v:1, id, z, b})`, where `b`
 * binds it to the query it was issued for - `base64url(sha256("v1|" + queryBbox.join(",") + "|" + zoom + "|" +
 * limit))[0..16)`, computed from the exact float64 `queryBbox` - so replaying it against another bbox, zoom or limit is
 * a 400 INVALID_CURSOR instead of a silently wrong page. Version-history cursors are the last returned version number.
 */
import { createHash } from 'node:crypto';

import type { Bbox } from '@snapland/shared';
import { z } from 'zod';

import { BadRequestError } from '../../infra/http/errors.js';

/** The query a bbox cursor belongs to. */
export interface BboxCursorQuery {
  /** The snapped query bbox echoed in the response (never the raw request bbox). */
  queryBbox: Bbox;
  zoom: number;
  limit: number;
}

const CURSOR_VERSION = 1;
const BINDING_LENGTH = 16;

const BboxCursorSchema = z.strictObject({
  v: z.literal(CURSOR_VERSION),
  id: z.uuid(),
  z: z.number().int(),
  b: z.string().length(BINDING_LENGTH),
});

function invalidCursor(detail: string): BadRequestError {
  return new BadRequestError('INVALID_CURSOR', detail);
}

/** The 16-character binding of a cursor to its query (`Array.prototype.join` of the exact doubles). */
export function queryBinding({ queryBbox, zoom, limit }: BboxCursorQuery): string {
  return createHash('sha256')
    .update(`v1|${queryBbox.join(',')}|${zoom}|${limit}`)
    .digest('base64url')
    .slice(0, BINDING_LENGTH);
}

/** The cursor that continues the keyset after `lastId` for this query. */
export function encodeBboxCursor(lastId: string, query: BboxCursorQuery): string {
  const payload = { v: CURSOR_VERSION, id: lastId, z: query.zoom, b: queryBinding(query) };
  return Buffer.from(JSON.stringify(payload)).toString('base64url');
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/**
 * Decodes a bbox cursor and returns the id after which the next page starts.
 * @throws BadRequestError INVALID_CURSOR when the cursor is malformed or was issued for another query.
 */
export function decodeBboxCursor(cursor: string, query: BboxCursorQuery): string {
  const parsed = BboxCursorSchema.safeParse(parseJson(Buffer.from(cursor, 'base64url').toString('utf8')));
  if (!parsed.success) throw invalidCursor('The cursor is malformed.');
  if (parsed.data.z !== query.zoom || parsed.data.b !== queryBinding(query)) {
    throw invalidCursor('The cursor was issued for different query parameters (bbox, zoom or limit).');
  }
  return parsed.data.id;
}

/** Positive int4 in plain decimal notation (`area_versions.version` is an integer). */
const VERSION_CURSOR = /^[1-9]\d{0,9}$/;
const MAX_INT4 = 2_147_483_647;

/** The versions-list cursor: the last version returned, as text. */
export function encodeVersionCursor(lastVersion: number): string {
  return String(lastVersion);
}

/**
 * The version before which the next history page starts.
 * @throws BadRequestError INVALID_CURSOR
 */
export function decodeVersionCursor(cursor: string): number {
  const version = VERSION_CURSOR.test(cursor) ? Number(cursor) : Number.NaN;
  if (!Number.isSafeInteger(version) || version > MAX_INT4) throw invalidCursor('The cursor is malformed.');
  return version;
}
