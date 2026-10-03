/**
 * The rows the areas statements return (as node-postgres delivers them: int8 -> number via the pool parser, json ->
 * object, float8[] -> number[]) and their mapping to the API DTOs of SPEC section 6.3, done once per row here. Every
 * `UserRef` carries the user's palette `color` (UI.md S10: pulses and toasts use the actor's colour even when the
 * actor is not in presence), list items carry `createdById` (SG-31), and timestamps become ISO-8601 UTC strings.
 */
import type {
  AreaDto,
  AreaListItemDto,
  AreaOp,
  AreaVersionDto,
  Bbox,
  ChangeEventDto,
  ChangedField,
  ListGeometry,
  PolygonGeometry,
  UserRef,
} from '@snapland/shared';

export interface AreaRow {
  id: string;
  name: string;
  description: string | null;
  geometry: PolygonGeometry;
  area_km2: number;
  perimeter_km: number;
  vertex_count: number;
  bbox: number[];
  version: number;
  change_seq: number;
  created_by: string;
  created_by_name: string;
  created_by_color: string;
  updated_by: string;
  updated_by_name: string;
  updated_by_color: string;
  created_at: Date;
  updated_at: Date;
  deleted_at: Date | null;
  deleted_by: string | null;
  deleted_by_name: string | null;
  deleted_by_color: string | null;
}

export interface BboxRow {
  id: string;
  name: string;
  area_km2: number;
  version: number;
  change_seq: number;
  updated_at: Date;
  created_by: string;
  updated_by: string;
  updated_by_name: string;
  updated_by_color: string;
  /** LOD geometry; null only on the sentinel row past the page budget (section 5.5). */
  geometry: ListGeometry | null;
  bbox: number[];
}

/** A bbox list row: an item once it carries geometry; the budget sentinel has none. */
export type BboxListRow = Omit<AreaListItemDto, 'geometry'> & { geometry: ListGeometry | null };

export interface VersionRow {
  area_id: string;
  version: number;
  op: AreaOp;
  name: string;
  description: string | null;
  /** Present when the statement was asked for geometry. */
  geometry: PolygonGeometry | null;
  area_km2: number;
  perimeter_km: number;
  vertex_count: number;
  changed_fields: ChangedField[];
  merged: boolean;
  reverted_from: number | null;
  change_seq: number;
  actor_id: string | null;
  actor_name: string | null;
  actor_color: string | null;
  created_at: Date;
}

/** One change-feed row: a version plus what is needed to render the area as of that version. */
export interface ChangeRow {
  change_seq: number;
  op: AreaOp;
  area_id: string;
  version: number;
  name: string;
  description: string | null;
  geometry: PolygonGeometry;
  area_km2: number;
  perimeter_km: number;
  vertex_count: number;
  changed_fields: ChangedField[];
  merged: boolean;
  created_at: Date;
  bbox: number[];
  actor_id: string | null;
  actor_name: string | null;
  actor_color: string | null;
  created_by: string;
  created_by_name: string;
  created_by_color: string;
  area_created_at: Date;
}

function toBbox(values: readonly number[]): Bbox {
  const [west, south, east, north] = values;
  if (west === undefined || south === undefined || east === undefined || north === undefined) {
    throw new Error(`expected a 4-number bbox, got ${values.length} values`);
  }
  return [west, south, east, north];
}

function userRef(id: string, displayName: string, color: string): UserRef {
  return { id, displayName, color };
}

/** A nullable LEFT JOIN user (deleted_by, actor): present only when all three columns are. */
function optionalUserRef(id: string | null, name: string | null, color: string | null): UserRef | null {
  return id === null || name === null || color === null ? null : userRef(id, name, color);
}

export function toAreaDto(row: AreaRow): AreaDto {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    geometry: row.geometry,
    areaKm2: row.area_km2,
    perimeterKm: row.perimeter_km,
    vertexCount: row.vertex_count,
    bbox: toBbox(row.bbox),
    version: row.version,
    changeSeq: row.change_seq,
    createdBy: userRef(row.created_by, row.created_by_name, row.created_by_color),
    updatedBy: userRef(row.updated_by, row.updated_by_name, row.updated_by_color),
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
    deletedAt: row.deleted_at?.toISOString() ?? null,
    deletedBy: optionalUserRef(row.deleted_by, row.deleted_by_name, row.deleted_by_color),
  };
}

/** Key order matters: bbox pages are serialised once and cached as text (section 10.2), so the body must stay stable. */
export function toBboxListRow(row: BboxRow): BboxListRow {
  return {
    id: row.id,
    name: row.name,
    geometry: row.geometry,
    bbox: toBbox(row.bbox),
    areaKm2: row.area_km2,
    version: row.version,
    changeSeq: row.change_seq,
    createdById: row.created_by,
    updatedBy: userRef(row.updated_by, row.updated_by_name, row.updated_by_color),
    updatedAt: row.updated_at.toISOString(),
  };
}

/** A history entry; geometry only when the caller asked for it (lists default to none, a single version has it). */
export function toAreaVersionDto(row: VersionRow): AreaVersionDto {
  const dto: AreaVersionDto = {
    areaId: row.area_id,
    version: row.version,
    op: row.op,
    name: row.name,
    description: row.description,
    areaKm2: row.area_km2,
    perimeterKm: row.perimeter_km,
    vertexCount: row.vertex_count,
    changedFields: row.changed_fields,
    merged: row.merged,
    revertedFrom: row.reverted_from,
    changeSeq: row.change_seq,
    actor: optionalUserRef(row.actor_id, row.actor_name, row.actor_color),
    createdAt: row.created_at.toISOString(),
  };
  if (row.geometry !== null) dto.geometry = row.geometry;
  return dto;
}

/**
 * The area as of one change: the version's content, the area's creator, and the version's actor as `updatedBy`
 * (falling back to the creator when the actor is unknown). A delete version is a tombstone (`deletedAt` = its time).
 */
export function toChangeEventDto(row: ChangeRow): ChangeEventDto {
  const createdBy = userRef(row.created_by, row.created_by_name, row.created_by_color);
  const actor = optionalUserRef(row.actor_id, row.actor_name, row.actor_color);
  const updatedBy = actor ?? createdBy;
  const occurredAt = row.created_at.toISOString();
  const deleted = row.op === 'delete';
  return {
    changeSeq: row.change_seq,
    op: row.op,
    areaId: row.area_id,
    version: row.version,
    area: {
      id: row.area_id,
      name: row.name,
      description: row.description,
      geometry: row.geometry,
      areaKm2: row.area_km2,
      perimeterKm: row.perimeter_km,
      vertexCount: row.vertex_count,
      bbox: toBbox(row.bbox),
      version: row.version,
      changeSeq: row.change_seq,
      createdBy,
      updatedBy,
      createdAt: row.area_created_at.toISOString(),
      updatedAt: occurredAt,
      deletedAt: deleted ? occurredAt : null,
      deletedBy: deleted ? updatedBy : null,
    },
    changedFields: row.changed_fields,
    merged: row.merged,
    actor,
    occurredAt,
  };
}
