/**
 * Payloads of the cross-instance bus channels (SPEC section 7.10). Remote messages are validated with these schemas before
 * any subscriber sees them (defence in depth, section 10.7.1); local deliveries are typed at compile time.
 */
import {
  AreaDtoSchema,
  AreaOpSchema,
  BboxSchema,
  ChangedFieldSchema,
  HexColorSchema,
  IsoDateTimeSchema,
  PositionSchema,
  PresenceDtoSchema,
  UserRefSchema,
  UuidSchema,
} from '@snapland/shared';
import { z } from 'zod';

/** `snap:ch:areas` - produced by the areas service after COMMIT. */
export const AreasBusPayloadSchema = z.object({
  changeSeq: z.number().int(),
  op: AreaOpSchema,
  area: AreaDtoSchema,
  prevBbox: BboxSchema.nullable(),
  previousName: z.string().nullable(),
  changedFields: z.array(ChangedFieldSchema),
  merged: z.boolean(),
  actor: UserRefSchema.nullable(),
});

const DraftUserSchema = z.object({ id: UuidSchema, displayName: z.string(), color: HexColorSchema });

/** `snap:ch:drafts` - produced by the realtime gateway. */
export const DraftsBusPayloadSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('updated'),
    draftId: UuidSchema,
    connectionId: UuidSchema,
    user: DraftUserSchema,
    areaId: UuidSchema.nullable(),
    rev: z.number().int().min(0),
    vertices: z.array(PositionSchema),
    cursor: PositionSchema.nullable(),
    /** Bbox of vertices + cursor (interest filtering); null while the draft has no point yet. */
    bbox: BboxSchema.nullable(),
  }),
  z.object({
    kind: z.literal('ended'),
    draftId: UuidSchema,
    connectionId: UuidSchema,
    user: DraftUserSchema,
    areaId: UuidSchema.nullable(),
    outcome: z.enum(['committed', 'cancelled', 'expired', 'disconnected']),
    bbox: BboxSchema.nullable(),
  }),
]);

/** `snap:ch:presence` - produced by the gateway and the sweeper. */
export const PresenceBusPayloadSchema = z.object({
  kind: z.enum(['joined', 'updated', 'left']),
  presence: PresenceDtoSchema.optional(),
  connectionId: UuidSchema,
  userId: UuidSchema,
});

/** `snap:ch:locks` - produced by the gateway. */
export const LocksBusPayloadSchema = z.object({
  areaId: UuidSchema,
  bbox: BboxSchema.nullable(),
  holder: z.object({ userId: UuidSchema, displayName: z.string(), color: HexColorSchema }).nullable(),
  scope: z.enum(['geometry', 'details']).nullable(),
  expiresAt: IsoDateTimeSchema.nullable(),
});

/** `snap:ch:sessions` - produced by the auth service and the user-admin CLI; gateways close sockets with 4401. */
export const SessionsBusPayloadSchema = z.object({
  kind: z.literal('revoked'),
  sessionId: UuidSchema,
  userId: UuidSchema,
  reason: z.enum(['logout', 'user_revoked', 'token_reuse', 'admin']),
});

export const BUS_PAYLOAD_SCHEMAS = {
  areas: AreasBusPayloadSchema,
  drafts: DraftsBusPayloadSchema,
  presence: PresenceBusPayloadSchema,
  locks: LocksBusPayloadSchema,
  sessions: SessionsBusPayloadSchema,
} as const;

export type AreasBusPayload = z.infer<typeof AreasBusPayloadSchema>;
export type DraftsBusPayload = z.infer<typeof DraftsBusPayloadSchema>;
export type PresenceBusPayload = z.infer<typeof PresenceBusPayloadSchema>;
export type LocksBusPayload = z.infer<typeof LocksBusPayloadSchema>;
export type SessionsBusPayload = z.infer<typeof SessionsBusPayloadSchema>;
