/**
 * Test data builders (test-only; not part of the app bundle). Ids are valid UUIDv4 so the shared zod schemas accept
 * them; colours come from the shared palette.
 */
import type { AreaDto, AreaListItemDto, Bbox, ChangeEventDto, Position, UserRef } from '@snapland/shared';

export const ALICE: UserRef = {
  id: '3f6c1a2e-0b1d-4c55-9a0e-7c1d2b3a4f50',
  displayName: 'Alice',
  color: '#c44f9d',
};
export const BOB: UserRef = {
  id: '5a1f9c3e-7b2d-4e6f-8a1b-2c3d4e5f6a7b',
  displayName: 'Bob',
  color: '#b86e3d',
};

let counter = 0;

/** A deterministic UUIDv4-shaped id with a sortable numeric tail. */
export function uuid(n?: number): string {
  counter += 1;
  const value = n ?? counter;
  return `00000000-0000-4000-8000-${value.toString(16).padStart(12, '0')}`;
}

export function squareRing(west: number, south: number, size: number): Position[] {
  return [
    [west, south],
    [west + size, south],
    [west + size, south + size],
    [west, south + size],
    [west, south],
  ];
}

export function bboxOf(west: number, south: number, size: number): Bbox {
  return [west, south, west + size, south + size];
}

export interface AreaInput {
  id: string;
  version?: number;
  changeSeq?: number;
  west?: number;
  south?: number;
  size?: number;
  name?: string;
  createdBy?: UserRef;
  deleted?: boolean;
}

export function areaDto(input: AreaInput): AreaDto {
  const west = input.west ?? 34.78;
  const south = input.south ?? 32.08;
  const size = input.size ?? 0.01;
  const createdBy = input.createdBy ?? ALICE;
  return {
    id: input.id,
    name: input.name ?? `Area ${input.id.slice(-4)}`,
    description: null,
    geometry: { type: 'Polygon', coordinates: [squareRing(west, south, size)] },
    areaKm2: 1,
    perimeterKm: 4,
    vertexCount: 4,
    bbox: bboxOf(west, south, size),
    version: input.version ?? 1,
    changeSeq: input.changeSeq ?? 1,
    createdBy,
    updatedBy: createdBy,
    createdAt: '2026-09-27T10:00:00.000Z',
    updatedAt: '2026-09-27T10:00:00.000Z',
    deletedAt: input.deleted === true ? '2026-09-27T10:05:00.000Z' : null,
    deletedBy: input.deleted === true ? createdBy : null,
  };
}

export function listItem(input: AreaInput): AreaListItemDto {
  const dto = areaDto(input);
  return {
    id: dto.id,
    name: dto.name,
    geometry: dto.geometry,
    bbox: dto.bbox,
    areaKm2: dto.areaKm2,
    version: dto.version,
    changeSeq: dto.changeSeq,
    createdById: dto.createdBy.id,
    updatedBy: dto.updatedBy,
    updatedAt: dto.updatedAt,
  };
}

export function changeEvent(input: AreaInput & { op?: ChangeEventDto['op'] }): ChangeEventDto {
  const area = areaDto(input);
  const op =
    input.op ?? (input.deleted === true ? 'delete' : (input.version ?? 1) === 1 ? 'create' : 'update');
  return {
    changeSeq: area.changeSeq,
    op,
    areaId: area.id,
    version: area.version,
    area,
    changedFields: op === 'delete' ? ['deleted'] : ['geometry'],
    merged: false,
    actor: area.updatedBy,
    occurredAt: area.updatedAt,
  };
}
