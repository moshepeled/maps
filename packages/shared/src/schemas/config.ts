/** `GET /api/v1/config` (SPEC section 6.4): the runtime limits and realtime settings the client reads at start-up. */
import { z } from 'zod';

export const ConfigResponseSchema = z.object({
  version: z.string(),
  limits: z.object({
    maxPositions: z.number().int(),
    maxRings: z.number().int(),
    minAreaKm2: z.number(),
    maxAreaKm2: z.number(),
    maxExtentDeg: z.number(),
    nameMaxLength: z.number().int(),
    descriptionMaxLength: z.number().int(),
    coordDecimals: z.number().int(),
    bboxMaxSpanPx: z.number().int(),
  }),
  rateLimits: z.object({ drawActionsPerWindow: z.number().int(), drawWindowMs: z.number().int() }),
  realtime: z.object({
    wsPath: z.string(),
    subprotocol: z.string(),
    heartbeatIntervalMs: z.number().int(),
    draftUpdateMinIntervalMs: z.number().int(),
    draftTouchIntervalMs: z.number().int(),
    maxPayloadBytes: z.number().int(),
    draftResumeWindowMs: z.number().int(),
  }),
});

export type ConfigResponse = z.infer<typeof ConfigResponseSchema>;
