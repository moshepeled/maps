/**
 * Client -> server messages (SPEC section 7.4). These schemas are STRICT: unknown keys and unknown types are rejected
 * (`error VALIDATION_FAILED` / `UNKNOWN_MESSAGE_TYPE`) and counted as invalid by the server.
 */
import { z } from 'zod';

import { LIMITS, REALTIME } from '../constants.js';
import { BoundedPositionSchema, UuidSchema } from '../schemas/common.js';
import { RefSchema, peekEnvelope, toProtocolIssues } from './envelope.js';
import type { ProtocolIssue } from './envelope.js';

const BoundedBboxSchema = z
  .tuple([
    z.number().min(-LIMITS.maxLongitude).max(LIMITS.maxLongitude),
    z.number().min(-LIMITS.maxLatitude).max(LIMITS.maxLatitude),
    z.number().min(-LIMITS.maxLongitude).max(LIMITS.maxLongitude),
    z.number().min(-LIMITS.maxLatitude).max(LIMITS.maxLatitude),
  ])
  .refine(([west, south, east, north]) => west <= east && south <= north, {
    message: 'bbox must be west <= east, south <= north',
  });

function clientMessage<T extends string, D extends z.ZodType>(type: T, data: D) {
  return z.strictObject({ type: z.literal(type), ref: RefSchema.optional(), data });
}

export const ClientMessageSchema = z.discriminatedUnion('type', [
  clientMessage(
    'viewport.set',
    z.strictObject({ bbox: BoundedBboxSchema, zoom: z.number().int().min(0).max(LIMITS.maxZoom) }),
  ),
  clientMessage('presence.update', z.strictObject({ status: z.enum(['viewing', 'idle']) })),
  clientMessage(
    'draft.start',
    z.strictObject({ draftId: UuidSchema, areaId: UuidSchema.nullable(), resume: z.boolean() }),
  ),
  clientMessage(
    'draft.update',
    z.strictObject({
      draftId: UuidSchema,
      rev: z.number().int().min(1),
      /** Open ring (no closing position), 6 dp; shape and range are validated, topology is not. */
      vertices: z.array(BoundedPositionSchema).max(REALTIME.maxDraftVertices),
      cursor: BoundedPositionSchema.nullable(),
    }),
  ),
  clientMessage('draft.touch', z.strictObject({ draftId: UuidSchema })),
  clientMessage(
    'draft.end',
    z
      .strictObject({
        draftId: UuidSchema,
        outcome: z.enum(['committed', 'cancelled']),
        areaId: UuidSchema.nullable(),
      })
      .refine((data) => data.outcome !== 'committed' || data.areaId !== null, {
        message: 'areaId is required when outcome is committed',
        path: ['areaId'],
      }),
  ),
  clientMessage(
    'lock.acquire',
    z.strictObject({ areaId: UuidSchema, scope: z.enum(['geometry', 'details']) }),
  ),
  clientMessage('lock.release', z.strictObject({ areaId: UuidSchema })),
  clientMessage('ping', z.strictObject({ t: z.number() })),
]);

export type ClientMessage = z.infer<typeof ClientMessageSchema>;
export type ClientMessageType = ClientMessage['type'];
export type ClientMessageOf<T extends ClientMessageType> = Extract<ClientMessage, { type: T }>;

/** Every client message type, in schema order. */
export const CLIENT_MESSAGE_TYPES: readonly ClientMessageType[] = ClientMessageSchema.options.map(
  (option) => option.shape.type.value,
);

const CLIENT_TYPE_SET: ReadonlySet<string> = new Set(CLIENT_MESSAGE_TYPES);

function isClientMessageType(type: string): type is ClientMessageType {
  return CLIENT_TYPE_SET.has(type);
}

export type ClientParseResult =
  | { ok: true; message: ClientMessage }
  | {
      ok: false;
      code: 'UNKNOWN_MESSAGE_TYPE' | 'VALIDATION_FAILED';
      ref: string | null;
      type: string | null;
      issues: ProtocolIssue[];
    };

/**
 * Parses an already JSON-decoded client frame. Unknown `type`s are reported as UNKNOWN_MESSAGE_TYPE, everything else
 * that does not match as VALIDATION_FAILED; `ref` is extracted when valid so the error can echo it.
 */
export function parseClientMessage(value: unknown): ClientParseResult {
  const { type, ref } = peekEnvelope(value);
  if (type === null || !isClientMessageType(type)) {
    return {
      ok: false,
      code: type === null ? 'VALIDATION_FAILED' : 'UNKNOWN_MESSAGE_TYPE',
      ref,
      type,
      issues: [
        { path: 'type', message: type === null ? 'type is required' : `unknown message type ${type}` },
      ],
    };
  }
  const parsed = ClientMessageSchema.safeParse(value);
  if (!parsed.success)
    return { ok: false, code: 'VALIDATION_FAILED', ref, type, issues: toProtocolIssues(parsed.error) };
  return { ok: true, message: parsed.data };
}
