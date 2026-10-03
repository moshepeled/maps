/**
 * Area schemas (SPEC section 6.3). Transport schemas bound JSON shape and abuse only; domain rules (section 9.2 geometry stages,
 * preconditions, permissions, bbox/cursor parsing) are enforced by services and return 422/428/403/409/INVALID_*.
 */
import { z } from 'zod';

import { LIMITS } from '../constants.js';
import {
  BboxSchema,
  IsoDateTimeSchema,
  PositionSchema,
  UserRefSchema,
  UuidSchema,
  queryInt,
} from './common.js';

/** Largest PostgreSQL `integer` (the type of `areas.version`). */
const PG_INT_MAX = 2_147_483_647;

// -- Transport (request) schemas ----------------------------------------------------------------

/**
 * Stage 0 of section 9.2: `type` is any short string (a Polygon-shaped `MultiPolygon` passes and fails later with 422
 * INVALID_GEOMETRY_TYPE); `coordinates` must be rings of `[number, number]`, so a genuine MultiPolygon (nested three
 * deep), a 3-number position and `1e999` are 400s.
 */
export const PolygonGeometryInSchema = z
  .strictObject({
    type: z.string().min(1).max(LIMITS.transportTypeMaxLength),
    coordinates: z.array(z.array(PositionSchema)).max(LIMITS.transportMaxRings),
  })
  .superRefine((geometry, context) => {
    const total = geometry.coordinates.reduce((sum, ring) => sum + ring.length, 0);
    if (total > LIMITS.transportMaxPositionsTotal) {
      context.addIssue({
        code: 'custom',
        path: ['coordinates'],
        message: `at most ${LIMITS.transportMaxPositionsTotal} positions in total`,
      });
    }
  });

const NameInSchema = z.string().max(LIMITS.nameRawMaxLength);
const DescriptionInSchema = z.string().max(LIMITS.descriptionRawMaxLength).nullable();
/** `baseVersion` is optional in transport: its absence is a service-level 428, not a 400 (section 3.5). */
const BaseVersionSchema = z.number().int().min(1);

export const CreateAreaRequestSchema = z.strictObject({
  id: UuidSchema.optional(),
  name: NameInSchema,
  description: DescriptionInSchema.optional(),
  geometry: PolygonGeometryInSchema,
});

export const UpdateAreaRequestSchema = z
  .strictObject({
    baseVersion: BaseVersionSchema.optional(),
    name: NameInSchema.optional(),
    description: DescriptionInSchema.optional(),
    geometry: PolygonGeometryInSchema.optional(),
    revertedFrom: z.number().int().min(1).optional(),
  })
  .refine(
    (body) => body.name !== undefined || body.description !== undefined || body.geometry !== undefined,
    {
      message: 'at least one of name, description or geometry is required',
    },
  );

export const RestoreAreaRequestSchema = z.strictObject({ baseVersion: BaseVersionSchema.optional() });

export const DeleteAreaQuerySchema = z.strictObject({ baseVersion: queryInt(1, PG_INT_MAX).optional() });

export const AreaIdParamsSchema = z.strictObject({ id: UuidSchema });

export const AreaVersionParamsSchema = z.strictObject({
  id: UuidSchema,
  version: queryInt(1, PG_INT_MAX),
});

export const AreaGetQuerySchema = z.strictObject({ includeDeleted: z.stringbool().optional() });

/** `bbox` is a bounded string here; `areas/bbox-params.ts` parses it and raises 400 INVALID_BBOX (section 6.3). */
export const AreaBboxQuerySchema = z.strictObject({
  bbox: z.string().min(1).max(LIMITS.bboxParamMaxLength),
  zoom: queryInt(0, LIMITS.maxZoom),
  limit: queryInt(1, LIMITS.bboxPageLimitMax).optional(),
  cursor: z.string().min(1).max(LIMITS.cursorMaxLength).optional(),
});

export const AreaVersionsQuerySchema = z.strictObject({
  limit: queryInt(1, LIMITS.versionsLimitMax).optional(),
  cursor: z.string().min(1).max(LIMITS.cursorMaxLength).optional(),
  includeGeometry: z.stringbool().optional(),
});

export const ChangeFeedQuerySchema = z.strictObject({
  since: queryInt(0, Number.MAX_SAFE_INTEGER),
  limit: queryInt(1, LIMITS.changeFeedLimitMax).optional(),
});

// -- Response / domain schemas -----------------------------------------------------------------

/** A valid polygon (section 9): 1-11 closed rings of >= 4 positions, <= 2,000 positions in total, 7 dp. */
export const PolygonGeometrySchema = z.object({
  type: z.literal('Polygon'),
  coordinates: z.array(z.array(PositionSchema)),
});

export const AreaDtoSchema = z.object({
  id: UuidSchema,
  name: z.string(),
  description: z.string().nullable(),
  geometry: PolygonGeometrySchema,
  areaKm2: z.number(),
  perimeterKm: z.number(),
  vertexCount: z.number().int(),
  bbox: BboxSchema,
  version: z.number().int(),
  changeSeq: z.number().int(),
  createdBy: UserRefSchema,
  updatedBy: UserRefSchema,
  createdAt: IsoDateTimeSchema,
  updatedAt: IsoDateTimeSchema,
  deletedAt: IsoDateTimeSchema.nullable(),
  deletedBy: UserRefSchema.nullable(),
});

export const AreaListItemDtoSchema = z.object({
  id: UuidSchema,
  name: z.string(),
  /** Display-only (section 5.5): may be simplified, so closed rings of >= 4 positions but no topology guarantee. */
  geometry: PolygonGeometrySchema,
  bbox: BboxSchema,
  areaKm2: z.number(),
  version: z.number().int(),
  changeSeq: z.number().int(),
  /** SG-31: lets the UI decide canDelete without fetching the full area. */
  createdById: UuidSchema,
  updatedBy: UserRefSchema,
  updatedAt: IsoDateTimeSchema,
});

export const MergeFieldSchema = z.enum(['name', 'description', 'geometry']);
export const ChangedFieldSchema = z.enum(['name', 'description', 'geometry', 'deleted']);
export const AreaOpSchema = z.enum(['create', 'update', 'delete', 'restore']);

export const AreaMutationResponseSchema = z.object({
  area: AreaDtoSchema,
  merged: z.boolean(),
  noop: z.boolean(),
  serverChangedFields: z.array(MergeFieldSchema),
});

export const AreaListResponseSchema = z.object({
  items: z.array(AreaListItemDtoSchema),
  nextCursor: z.string().nullable(),
  asOfChangeSeq: z.number().int(),
  simplified: z.boolean(),
  precision: z.number().int(),
  zoom: z.number().int(),
  queryBbox: BboxSchema,
  /** Culling threshold applied (0 at zoom >= 15). */
  minExtentDeg: z.number(),
  /** First page: live areas in queryBbox omitted by the threshold (capped at 10,000); later pages: null. */
  culledCount: z.number().int().nullable(),
});

export const AreaVersionDtoSchema = z.object({
  areaId: UuidSchema,
  version: z.number().int(),
  op: AreaOpSchema,
  name: z.string(),
  description: z.string().nullable(),
  geometry: PolygonGeometrySchema.optional(),
  areaKm2: z.number(),
  perimeterKm: z.number(),
  vertexCount: z.number().int(),
  changedFields: z.array(ChangedFieldSchema),
  merged: z.boolean(),
  revertedFrom: z.number().int().nullable(),
  changeSeq: z.number().int(),
  actor: UserRefSchema.nullable(),
  createdAt: IsoDateTimeSchema,
});

export const AreaVersionListResponseSchema = z.object({
  items: z.array(AreaVersionDtoSchema),
  nextCursor: z.string().nullable(),
});

export const ChangeEventDtoSchema = z.object({
  changeSeq: z.number().int(),
  op: AreaOpSchema,
  areaId: UuidSchema,
  version: z.number().int(),
  area: AreaDtoSchema,
  changedFields: z.array(ChangedFieldSchema),
  merged: z.boolean(),
  actor: UserRefSchema.nullable(),
  occurredAt: IsoDateTimeSchema,
});

export const ChangeFeedResponseSchema = z.object({
  items: z.array(ChangeEventDtoSchema),
  nextSince: z.number().int(),
  hasMore: z.boolean(),
  latestChangeSeq: z.number().int(),
});

export type PolygonGeometryIn = z.infer<typeof PolygonGeometryInSchema>;
export type CreateAreaRequest = z.infer<typeof CreateAreaRequestSchema>;
export type UpdateAreaRequest = z.infer<typeof UpdateAreaRequestSchema>;
export type RestoreAreaRequest = z.infer<typeof RestoreAreaRequestSchema>;
export type AreaBboxQuery = z.infer<typeof AreaBboxQuerySchema>;
export type AreaVersionsQuery = z.infer<typeof AreaVersionsQuerySchema>;
export type PolygonGeometry = z.infer<typeof PolygonGeometrySchema>;
/** List geometry has the polygon shape but is display-only (see AreaListItemDtoSchema.geometry). */
export type ListGeometry = PolygonGeometry;
export type AreaDto = z.infer<typeof AreaDtoSchema>;
export type AreaListItemDto = z.infer<typeof AreaListItemDtoSchema>;
export type MergeField = z.infer<typeof MergeFieldSchema>;
export type ChangedField = z.infer<typeof ChangedFieldSchema>;
export type AreaOp = z.infer<typeof AreaOpSchema>;
export type AreaMutationResponse = z.infer<typeof AreaMutationResponseSchema>;
export type AreaListResponse = z.infer<typeof AreaListResponseSchema>;
export type AreaVersionDto = z.infer<typeof AreaVersionDtoSchema>;
export type AreaVersionListResponse = z.infer<typeof AreaVersionListResponseSchema>;
export type ChangeEventDto = z.infer<typeof ChangeEventDtoSchema>;
export type ChangeFeedResponse = z.infer<typeof ChangeFeedResponseSchema>;
