/** Message envelope of the `snapland.v1` WebSocket protocol (SPEC section 7.3): `{ type, ref?, data }`, UTF-8 JSON text. */
import { z } from 'zod';

import { REALTIME } from '../constants.js';

/** Correlation id chosen by the client and echoed on the matching `ack`/`error`. */
export const RefSchema = z.string().regex(new RegExp(REALTIME.refPattern));

/** Extracts `type` and `ref` from any JSON value without validating the rest (used before full parsing). */
export function peekEnvelope(value: unknown): { type: string | null; ref: string | null } {
  if (typeof value !== 'object' || value === null) return { type: null, ref: null };
  const record = value as Record<string, unknown>;
  const type = typeof record['type'] === 'string' ? record['type'] : null;
  const ref = RefSchema.safeParse(record['ref']);
  return { type, ref: ref.success ? ref.data : null };
}

export interface ProtocolIssue {
  path: string;
  message: string;
}

/** Flattens zod issues into `{ path, message }` pairs for `error.details` and client-error reports. */
export function toProtocolIssues(error: z.ZodError): ProtocolIssue[] {
  return error.issues.map((issue) => ({ path: issue.path.map(String).join('.'), message: issue.message }));
}
