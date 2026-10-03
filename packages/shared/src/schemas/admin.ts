/** Admin audit endpoints (SPEC section 6.4): row-level drill-down and analytics over `audit_logs`. */
import { z } from 'zod';

import { LIMITS } from '../constants.js';
import { IsoDateTimeSchema, UuidSchema, queryInt } from './common.js';

export const AuditOutcomeSchema = z.enum(['success', 'failure', 'denied']);

/** `<domain>.<verb>`, the audit action format (matches the `audit_logs_action_ck` CHECK). */
const AUDIT_ACTION_PATTERN = '^[a-z_]+\\.[a-z_]+$';

export const AuditLogQuerySchema = z.strictObject({
  actorId: UuidSchema.optional(),
  action: z.string().max(64).regex(new RegExp(AUDIT_ACTION_PATTERN)).optional(),
  outcome: AuditOutcomeSchema.optional(),
  from: IsoDateTimeSchema.optional(),
  to: IsoDateTimeSchema.optional(),
  limit: queryInt(1, LIMITS.auditLogsLimitMax).optional(),
  cursor: z.string().min(1).max(64).optional(),
});

export const AuditLogDtoSchema = z.object({
  id: z.number().int(),
  occurredAt: IsoDateTimeSchema,
  action: z.string(),
  outcome: AuditOutcomeSchema,
  actorId: UuidSchema.nullable(),
  sessionId: UuidSchema.nullable(),
  targetType: z.string().nullable(),
  targetId: z.string().nullable(),
  requestId: z.string().nullable(),
  instanceId: z.string(),
  ip: z.string().nullable(),
  userAgent: z.string().nullable(),
  details: z.record(z.string(), z.unknown()),
});

export const AuditLogListResponseSchema = z.object({
  items: z.array(AuditLogDtoSchema),
  nextCursor: z.string().nullable(),
});

/** Window <= 31 days, default the last 24 h (enforced by the service). */
export const AuditStatsQuerySchema = z.strictObject({
  from: IsoDateTimeSchema.optional(),
  to: IsoDateTimeSchema.optional(),
});

export const AuditStatsResponseSchema = z.object({
  from: IsoDateTimeSchema,
  to: IsoDateTimeSchema,
  actionsByHour: z.array(
    z.object({
      hour: IsoDateTimeSchema,
      action: z.string(),
      outcome: AuditOutcomeSchema,
      events: z.number().int(),
      actors: z.number().int(),
    }),
  ),
  topEditors: z.array(
    z.object({
      actorId: UuidSchema,
      displayName: z.string().nullable(),
      creates: z.number().int(),
      updates: z.number().int(),
      deletesRestores: z.number().int(),
    }),
  ),
  conflictRate: z.array(
    z.object({
      day: IsoDateTimeSchema,
      updates: z.number().int(),
      merged: z.number().int(),
      conflicts: z.number().int(),
      rate: z.number(),
    }),
  ),
  rateLimitHits: z.array(
    z.object({ day: IsoDateTimeSchema, scope: z.string().nullable(), hits: z.number().int() }),
  ),
});

export type AuditOutcome = z.infer<typeof AuditOutcomeSchema>;
export type AuditLogQuery = z.infer<typeof AuditLogQuerySchema>;
export type AuditLogDto = z.infer<typeof AuditLogDtoSchema>;
export type AuditLogListResponse = z.infer<typeof AuditLogListResponseSchema>;
export type AuditStatsQuery = z.infer<typeof AuditStatsQuerySchema>;
export type AuditStatsResponse = z.infer<typeof AuditStatsResponseSchema>;
