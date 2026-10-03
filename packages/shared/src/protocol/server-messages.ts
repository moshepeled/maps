/**
 * Server -> client messages (SPEC section 7.5). These schemas are LOOSE: unknown fields are tolerated and preserved, and an
 * unknown `type` yields `{ kind: 'unknown' }` instead of an error, so servers can add fields and message types without
 * breaking older clients. A message that fails its schema is dropped and reported (`POST /client-errors`, ws_schema).
 */
import { z } from 'zod';

import { AreaDtoSchema, AreaOpSchema, ChangedFieldSchema } from '../schemas/areas.js';
import {
  HexColorSchema,
  IsoDateTimeSchema,
  PositionSchema,
  UserRefSchema,
  UuidSchema,
} from '../schemas/common.js';
import { PresenceDtoSchema } from '../schemas/presence.js';
import { RefSchema, peekEnvelope, toProtocolIssues } from './envelope.js';
import type { ProtocolIssue } from './envelope.js';

/** `{ id, displayName, color }` of a draft author or connected user. */
const WsUserSchema = z.looseObject({ id: UuidSchema, displayName: z.string(), color: HexColorSchema });
/** `{ userId, displayName, color }` of a lock holder. */
const LockHolderSchema = z.looseObject({
  userId: UuidSchema,
  displayName: z.string(),
  color: HexColorSchema,
});
const LockScopeSchema = z.enum(['geometry', 'details']);
const PresenceEventDataSchema = z.looseObject({ presence: PresenceDtoSchema });

function serverMessage<T extends string, D extends z.ZodType>(type: T, data: D) {
  return z.looseObject({ type: z.literal(type), ref: RefSchema.optional(), data });
}

export const ServerMessageSchema = z.discriminatedUnion('type', [
  serverMessage(
    'welcome',
    z.looseObject({
      connectionId: UuidSchema,
      instanceId: z.string(),
      user: WsUserSchema,
      /** Epoch milliseconds (the same type as `pong.serverTime`). */
      serverTime: z.number(),
      latestChangeSeq: z.number().int(),
      heartbeatIntervalMs: z.number().int(),
      limits: z.looseObject({
        maxPayloadBytes: z.number().int(),
        drawActionsPerWindow: z.number().int(),
        drawWindowMs: z.number().int(),
        draftUpdateMinIntervalMs: z.number().int(),
        draftTouchIntervalMs: z.number().int(),
        maxPositions: z.number().int(),
      }),
    }),
  ),
  serverMessage('ack', z.looseObject({ drawActionsRemaining: z.number().int().optional() })),
  serverMessage(
    'error',
    z.looseObject({
      /** A WsErrorCode; kept open-ended so newer servers can add codes. */
      code: z.string(),
      message: z.string(),
      retryAfterMs: z.number().optional(),
      details: z.unknown().optional(),
    }),
  ),
  serverMessage('pong', z.looseObject({ t: z.number(), serverTime: z.number() })),
  serverMessage(
    'presence.snapshot',
    z.looseObject({
      items: z.array(PresenceDtoSchema),
      onlineCount: z.number().int(),
      truncated: z.boolean(),
    }),
  ),
  serverMessage(
    'lock.snapshot',
    z.looseObject({
      items: z.array(
        z.looseObject({
          areaId: UuidSchema,
          holder: LockHolderSchema,
          scope: LockScopeSchema,
          expiresAt: IsoDateTimeSchema,
        }),
      ),
    }),
  ),
  serverMessage('presence.joined', PresenceEventDataSchema),
  serverMessage('presence.updated', PresenceEventDataSchema),
  serverMessage('presence.left', z.looseObject({ connectionId: UuidSchema, userId: UuidSchema })),
  serverMessage(
    'area.changed',
    z.looseObject({
      changeSeq: z.number().int(),
      op: AreaOpSchema,
      area: AreaDtoSchema,
      changedFields: z.array(ChangedFieldSchema),
      merged: z.boolean(),
      previousName: z.string().nullable(),
      actor: UserRefSchema.nullable(),
    }),
  ),
  serverMessage(
    'draft.updated',
    z.looseObject({
      draftId: UuidSchema,
      user: WsUserSchema,
      areaId: UuidSchema.nullable(),
      /** 0 for the announcement published on draft.start. */
      rev: z.number().int().min(0),
      vertices: z.array(PositionSchema),
      cursor: PositionSchema.nullable(),
    }),
  ),
  serverMessage(
    'draft.ended',
    z.looseObject({
      draftId: UuidSchema,
      userId: UuidSchema,
      outcome: z.enum(['committed', 'cancelled', 'expired', 'disconnected']),
      areaId: UuidSchema.nullable(),
    }),
  ),
  serverMessage('lock.acquired', z.looseObject({ areaId: UuidSchema, expiresAt: IsoDateTimeSchema })),
  serverMessage(
    'lock.changed',
    z.looseObject({
      areaId: UuidSchema,
      holder: LockHolderSchema.nullable(),
      scope: LockScopeSchema.nullable(),
      expiresAt: IsoDateTimeSchema.nullable(),
    }),
  ),
  serverMessage(
    'resync.required',
    z.looseObject({
      reason: z.enum(['bus_reconnected', 'instance_degraded']),
      latestChangeSeq: z.number().int(),
    }),
  ),
  /** Inner messages are parsed one by one (`parseServerMessage`), so one unknown inner type never drops the batch. */
  serverMessage('batch', z.looseObject({ messages: z.array(z.looseObject({ type: z.string() })) })),
]);

export type ServerMessage = z.infer<typeof ServerMessageSchema>;
export type ServerMessageType = ServerMessage['type'];
export type ServerMessageOf<T extends ServerMessageType> = Extract<ServerMessage, { type: T }>;

/** Every server message type, in schema order. */
export const SERVER_MESSAGE_TYPES: readonly ServerMessageType[] = ServerMessageSchema.options.map(
  (option) => option.shape.type.value,
);

const SERVER_TYPE_SET: ReadonlySet<string> = new Set(SERVER_MESSAGE_TYPES);

export type ServerParseResult =
  | { kind: 'message'; message: Exclude<ServerMessage, { type: 'batch' }> }
  | { kind: 'batch'; results: ServerParseResult[] }
  | { kind: 'unknown'; type: string }
  | { kind: 'invalid'; type: string | null; issues: ProtocolIssue[] };

function isServerMessageType(type: string): type is ServerMessageType {
  return SERVER_TYPE_SET.has(type);
}

/** Parses an already JSON-decoded server frame without throwing (forward compatible, see the module comment). */
export function parseServerMessage(value: unknown): ServerParseResult {
  const { type } = peekEnvelope(value);
  if (type === null)
    return { kind: 'invalid', type: null, issues: [{ path: 'type', message: 'type is required' }] };
  if (!isServerMessageType(type)) return { kind: 'unknown', type };
  const parsed = ServerMessageSchema.safeParse(value);
  if (!parsed.success) return { kind: 'invalid', type, issues: toProtocolIssues(parsed.error) };
  const message = parsed.data;
  if (message.type === 'batch') {
    return { kind: 'batch', results: message.data.messages.map((inner) => parseServerMessage(inner)) };
  }
  return { kind: 'message', message };
}
