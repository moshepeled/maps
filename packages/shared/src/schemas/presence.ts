/** Presence schemas (SPEC section 7.5, section 7.7): shared by the WebSocket snapshot/events and the REST fallback. */
import { z } from 'zod';

import { LIMITS } from '../constants.js';
import { BboxSchema, HexColorSchema, IsoDateTimeSchema, UuidSchema } from './common.js';

export const PresenceStatusSchema = z.enum(['viewing', 'drawing', 'editing', 'idle']);

export const ViewportSchema = z.object({
  bbox: BboxSchema,
  zoom: z.number().int().min(0).max(LIMITS.maxZoom),
});

export const PresenceDtoSchema = z.object({
  connectionId: UuidSchema,
  userId: UuidSchema,
  displayName: z.string(),
  /** One of the 12 USER_PALETTE colours, stored in users.color. */
  color: HexColorSchema,
  status: PresenceStatusSchema,
  /** The area being edited, or the draft id while drawing a new one. */
  activeAreaId: UuidSchema.nullable(),
  viewport: ViewportSchema.nullable(),
  connectedAt: IsoDateTimeSchema,
  updatedAt: IsoDateTimeSchema,
});

export const PresenceListResponseSchema = z.object({
  items: z.array(PresenceDtoSchema),
  /** Distinct online users. */
  onlineCount: z.number().int(),
  truncated: z.boolean(),
});

export type PresenceStatus = z.infer<typeof PresenceStatusSchema>;
export type Viewport = z.infer<typeof ViewportSchema>;
export type PresenceDto = z.infer<typeof PresenceDtoSchema>;
export type PresenceListResponse = z.infer<typeof PresenceListResponseSchema>;
