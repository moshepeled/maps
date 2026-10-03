/**
 * Areas endpoints (SPEC section 6.3), every response parsed with the shared schemas. Also holds the one client-side reading
 * of a restore conflict (SG-15): a retried restore whose first attempt succeeded is a success, not an error.
 */
import type {
  AreaDto,
  AreaMutationResponse,
  AreaVersionDto,
  AreaVersionListResponse,
  Bbox,
  ChangeFeedResponse,
  CreateAreaRequest,
  UpdateAreaRequest,
} from '@snapland/shared';
import {
  AreaDtoSchema,
  AreaListResponseSchema,
  AreaMutationResponseSchema,
  AreaVersionDtoSchema,
  AreaVersionListResponseSchema,
  ChangeFeedResponseSchema,
} from '@snapland/shared';

import { FeedExpiredError } from '../state/areasSync';
import type { ListPage } from '../state/areasSync';
import type { ApiError, HttpClient } from './http';
import { isApiError } from './http';

export interface AreasApi {
  listBbox(
    params: { bbox: Bbox; zoom: number; limit: number; cursor: string | null },
    signal: AbortSignal,
  ): Promise<ListPage>;
  changes(params: { since: number; limit: number }, signal: AbortSignal): Promise<ChangeFeedResponse>;
  get(id: string, options?: { includeDeleted?: boolean; signal?: AbortSignal }): Promise<AreaDto>;
  create(body: CreateAreaRequest): Promise<AreaMutationResponse>;
  update(id: string, body: UpdateAreaRequest): Promise<AreaMutationResponse>;
  remove(id: string, baseVersion: number): Promise<AreaMutationResponse>;
  restore(id: string, baseVersion: number): Promise<AreaMutationResponse>;
  versions(id: string, signal?: AbortSignal): Promise<AreaVersionListResponse>;
  version(id: string, version: number, signal?: AbortSignal): Promise<AreaVersionDto>;
}

/** Formats a bbox for the query string (full float64 precision; the server parses and validates it). */
export function bboxParam(bbox: Bbox): string {
  return bbox.map((value) => String(value)).join(',');
}

/**
 * SG-15 / UX F-06 step 3: a restore answered 409 AREA_NOT_DELETED whose `current` is live at `baseVersion + 1` means
 * our earlier attempt already succeeded - return that state as the success result. Anything else stays an error.
 */
export function restoreConflictAsSuccess(error: unknown, baseVersion: number): AreaMutationResponse | null {
  if (!isApiError(error, 'AREA_NOT_DELETED')) return null;
  const parsed = AreaDtoSchema.safeParse(error.extension('current'));
  if (!parsed.success) return null;
  const current = parsed.data;
  if (current.deletedAt !== null || current.version !== baseVersion + 1) return null;
  return { area: current, merged: false, noop: false, serverChangedFields: [] };
}

/** The `current` AreaDto carried by 409 problems (VERSION_CONFLICT, AREA_DELETED, AREA_NOT_DELETED). */
export function problemCurrent(error: ApiError): AreaDto | null {
  const parsed = AreaDtoSchema.safeParse(error.extension('current'));
  return parsed.success ? parsed.data : null;
}

export function createAreasApi(http: HttpClient): AreasApi {
  return {
    async listBbox({ bbox, zoom, limit, cursor }, signal) {
      const response = await http.request('/areas', {
        query: { bbox: bboxParam(bbox), zoom, limit, cursor },
        schema: AreaListResponseSchema,
        signal,
      });
      return { ...response.data, bytes: response.bytes };
    },
    async changes({ since, limit }, signal) {
      try {
        const response = await http.request('/areas/changes', {
          query: { since, limit },
          schema: ChangeFeedResponseSchema,
          signal,
        });
        return response.data;
      } catch (error) {
        if (isApiError(error, 'CHANGE_FEED_EXPIRED')) throw new FeedExpiredError();
        throw error;
      }
    },
    async get(id, options = {}) {
      const response = await http.request(`/areas/${encodeURIComponent(id)}`, {
        query: { includeDeleted: options.includeDeleted === true ? 'true' : undefined },
        schema: AreaDtoSchema,
        signal: options.signal,
      });
      return response.data;
    },
    async create(body) {
      const response = await http.request('/areas', {
        method: 'POST',
        body,
        schema: AreaMutationResponseSchema,
      });
      return response.data;
    },
    async update(id, body) {
      const response = await http.request(`/areas/${encodeURIComponent(id)}`, {
        method: 'PATCH',
        body,
        schema: AreaMutationResponseSchema,
      });
      return response.data;
    },
    async remove(id, baseVersion) {
      const response = await http.request(`/areas/${encodeURIComponent(id)}`, {
        method: 'DELETE',
        query: { baseVersion },
        schema: AreaMutationResponseSchema,
      });
      return response.data;
    },
    async restore(id, baseVersion) {
      try {
        const response = await http.request(`/areas/${encodeURIComponent(id)}/restore`, {
          method: 'POST',
          body: { baseVersion },
          schema: AreaMutationResponseSchema,
        });
        return response.data;
      } catch (error) {
        const success = restoreConflictAsSuccess(error, baseVersion);
        if (success !== null) return success;
        throw error;
      }
    },
    async versions(id, signal) {
      const response = await http.request(`/areas/${encodeURIComponent(id)}/versions`, {
        query: { limit: 50 },
        schema: AreaVersionListResponseSchema,
        signal,
      });
      return response.data;
    },
    async version(id, version, signal) {
      const response = await http.request(`/areas/${encodeURIComponent(id)}/versions/${version}`, {
        schema: AreaVersionDtoSchema,
        signal,
      });
      return response.data;
    },
  };
}
