/**
 * Building blocks of every REST and WebSocket schema (zod 4, the single schema language - ADR-0002).
 * Request (transport) schemas are strict: unknown keys are rejected with 400 VALIDATION_FAILED.
 */
import { z } from 'zod';

import { COLOR_PATTERN, LIMITS } from '../constants.js';

export const UuidSchema = z.uuid();

/** ISO-8601 timestamp (the API always emits UTC `...Z`). */
export const IsoDateTimeSchema = z.iso.datetime({ offset: true });

export const HexColorSchema = z
  .string()
  .regex(new RegExp(COLOR_PATTERN), 'must be a lowercase #rrggbb colour');

/**
 * Position `[lng, lat]`: exactly two finite JSON numbers. zod 4 `z.number()` rejects +/-Infinity and NaN, so a transport
 * `1e999` (parsed by JSON.parse to Infinity) fails here with 400 (section 3.5).
 */
export const PositionSchema = z.tuple([z.number(), z.number()]);

/** A position constrained to the valid WGS84 / Web-Mercator range (WS drafts, viewports). */
export const BoundedPositionSchema = z.tuple([
  z.number().min(-LIMITS.maxLongitude).max(LIMITS.maxLongitude),
  z.number().min(-LIMITS.maxLatitude).max(LIMITS.maxLatitude),
]);

/** `[west, south, east, north]`. */
export const BboxSchema = z.tuple([z.number(), z.number(), z.number(), z.number()]);

/** A user reference embedded in DTOs; `color` is required so pulses and toasts use the actor's colour (UI S10). */
export const UserRefSchema = z.object({
  id: UuidSchema,
  displayName: z.string(),
  color: HexColorSchema,
});

export const RoleSchema = z.enum(['user', 'admin']);

/** An integer query-string parameter (query strings arrive as text). */
export function queryInt(min: number, max: number) {
  return z.coerce.number().int().min(min).max(max);
}

export type UserRef = z.infer<typeof UserRefSchema>;
export type Role = z.infer<typeof RoleSchema>;
