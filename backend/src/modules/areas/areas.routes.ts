/**
 * Transport layer of the areas API (SPEC section 6.1, section 6.3): transport schemas, authentication, the drawing-action charge,
 * audit routing and HTTP validators. No SQL and no business rules - those live in the services.
 *
 * Mutation pipeline order (section 6.3): `authenticate` (onRequest, 401) -> transport validation (400, free) ->
 * `drawRateLimit` (preHandler: charges 1 for everything after it, 429) -> service. Every mutation route declares
 * `config.auditAction`, so outcomes the service never saw (transport 400, 413, 415, 5xx) still get an audit row.
 */
import {
  AreaBboxQuerySchema,
  AreaDtoSchema,
  AreaGetQuerySchema,
  AreaIdParamsSchema,
  AreaListResponseSchema,
  AreaMutationResponseSchema,
  AreaVersionDtoSchema,
  AreaVersionListResponseSchema,
  AreaVersionParamsSchema,
  AreaVersionsQuerySchema,
  ChangeFeedQuerySchema,
  ChangeFeedResponseSchema,
  CreateAreaRequestSchema,
  DeleteAreaQuerySchema,
  RestoreAreaRequestSchema,
  UpdateAreaRequestSchema,
} from '@snapland/shared';
import type { AreaMutationResponse } from '@snapland/shared';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';

import { UnauthorizedError } from '../../infra/http/errors.js';
import { SECURITY_BEARER, withProblems } from '../../infra/http/openapi.js';
import type { AppInstance } from '../../infra/http/types.js';
import type { AreasQueryService } from './areas-query.service.js';
import type { AreasService } from './areas.service.js';
import type { AreasActor, MutationResult } from './areas.types.js';
import { ifNoneMatchHits, versionEtag, weakBodyEtag, xCacheValue } from './http-caching.js';

export interface AreasRoutesDeps {
  service: AreasService;
  queries: AreasQueryService;
}

const TAGS = ['areas'];
const NOT_MODIFIED = z.null().describe('Not modified (If-None-Match matched the ETag)');
/** Validators are always revalidated: the body may change with any write (section 10.2). */
const REVALIDATE = 'private, no-cache';

/** The authenticated caller; `authenticate` ran in onRequest, so a missing user is a wiring error surfaced as 401. */
function areasActor(request: FastifyRequest): AreasActor {
  const actor = request.actor();
  if (actor.userId === null || actor.sessionId === null || actor.role === null) {
    throw new UnauthorizedError('UNAUTHENTICATED', 'Authentication required.');
  }
  return { ...actor, userId: actor.userId, sessionId: actor.sessionId, role: actor.role };
}

/** 304 without a body (the documented `304` schema is for OpenAPI only; an absent payload skips serialisation). */
function sendNotModified(reply: FastifyReply): FastifyReply {
  return reply.code(304).send();
}

/** A body that is already JSON (bbox pages come serialised from the cache); the schema-typed reply refuses a string. */
function sendJsonText(reply: FastifyReply, body: string): FastifyReply {
  return reply.type('application/json; charset=utf-8').send(body);
}

/** The mutation body; `replay` is answered as a header, not a body field. */
function mutationResponse(result: MutationResult): AreaMutationResponse {
  const { area, merged, noop, serverChangedFields } = result;
  return { area, merged, noop, serverChangedFields };
}

export function registerAreasRoutes(app: AppInstance, { service, queries }: AreasRoutesDeps): void {
  app.get(
    '/api/v1/areas',
    {
      onRequest: [app.authenticate],
      schema: {
        summary: 'Areas in a bbox (LOD, keyset-paginated, span-capped, position-budgeted)',
        tags: TAGS,
        security: SECURITY_BEARER,
        querystring: AreaBboxQuerySchema,
        response: withProblems({ 200: AreaListResponseSchema, 304: NOT_MODIFIED }, 401),
      },
    },
    async (request, reply) => {
      const page = await queries.listInBbox(request.query);
      const etag = weakBodyEtag(page.body);
      Object.assign(request.logContext, {
        zoom: request.query.zoom,
        items: page.itemCount,
        cache: page.outcome,
      });
      reply
        .header('ETag', etag)
        .header('Cache-Control', REVALIDATE)
        .header('Vary', 'Authorization')
        .header('X-Cache', xCacheValue(page.outcome));
      if (ifNoneMatchHits(request.headers['if-none-match'], etag)) return sendNotModified(reply);
      return sendJsonText(reply, page.body);
    },
  );

  app.get(
    '/api/v1/areas/changes',
    {
      onRequest: [app.authenticate],
      schema: {
        summary: 'Change feed since a changeSeq',
        tags: TAGS,
        security: SECURITY_BEARER,
        querystring: ChangeFeedQuerySchema,
        response: withProblems({ 200: ChangeFeedResponseSchema }, 401, 410),
      },
    },
    (request) => queries.changesSince(request.query.since, request.query.limit),
  );

  app.get(
    '/api/v1/areas/:id',
    {
      onRequest: [app.authenticate],
      schema: {
        summary: 'One area at full precision',
        tags: TAGS,
        security: SECURITY_BEARER,
        params: AreaIdParamsSchema,
        querystring: AreaGetQuerySchema,
        response: withProblems({ 200: AreaDtoSchema, 304: NOT_MODIFIED }, 401, 404),
      },
    },
    async (request, reply) => {
      const area = await queries.getArea(request.params.id, request.query.includeDeleted === true);
      const etag = versionEtag(area.version);
      reply.header('ETag', etag).header('Cache-Control', REVALIDATE);
      if (ifNoneMatchHits(request.headers['if-none-match'], etag)) return sendNotModified(reply);
      return reply.code(200).send(area);
    },
  );

  app.get(
    '/api/v1/areas/:id/versions',
    {
      onRequest: [app.authenticate],
      schema: {
        summary: 'Edit history, newest first (also for soft-deleted areas until purge)',
        tags: TAGS,
        security: SECURITY_BEARER,
        params: AreaIdParamsSchema,
        querystring: AreaVersionsQuerySchema,
        response: withProblems({ 200: AreaVersionListResponseSchema }, 401, 404),
      },
    },
    (request) => queries.listVersions(request.params.id, request.query),
  );

  app.get(
    '/api/v1/areas/:id/versions/:version',
    {
      onRequest: [app.authenticate],
      schema: {
        summary: 'One version snapshot (also for soft-deleted areas until purge)',
        tags: TAGS,
        security: SECURITY_BEARER,
        params: AreaVersionParamsSchema,
        response: withProblems({ 200: AreaVersionDtoSchema }, 401, 404),
      },
    },
    (request) => queries.getVersion(request.params.id, request.params.version),
  );

  app.post(
    '/api/v1/areas',
    {
      onRequest: [app.authenticate],
      preHandler: [app.drawRateLimit('area.create')],
      config: { auditAction: 'area.create' },
      schema: {
        summary: 'Create an area (idempotent by client-supplied id)',
        tags: TAGS,
        security: SECURITY_BEARER,
        body: CreateAreaRequestSchema,
        response: withProblems(
          { 200: AreaMutationResponseSchema, 201: AreaMutationResponseSchema },
          401,
          409,
          413,
          415,
          422,
        ),
      },
    },
    async (request, reply) => {
      const result = await service.create(areasActor(request), request.body);
      reply.header('ETag', versionEtag(result.area.version));
      if (result.replay)
        return reply.code(200).header('Idempotent-Replay', 'true').send(mutationResponse(result));
      return reply
        .code(201)
        .header('Location', `/api/v1/areas/${result.area.id}`)
        .send(mutationResponse(result));
    },
  );

  app.patch(
    '/api/v1/areas/:id',
    {
      onRequest: [app.authenticate],
      preHandler: [app.drawRateLimit('area.update')],
      config: { auditAction: 'area.update' },
      schema: {
        summary: 'Update name, description and/or geometry (optimistic concurrency, field-level merge)',
        tags: TAGS,
        security: SECURITY_BEARER,
        params: AreaIdParamsSchema,
        body: UpdateAreaRequestSchema,
        response: withProblems({ 200: AreaMutationResponseSchema }, 401, 404, 409, 413, 415, 422, 428),
      },
    },
    async (request, reply) => {
      const result = await service.update(areasActor(request), request.params.id, request.body);
      return reply.code(200).header('ETag', versionEtag(result.area.version)).send(mutationResponse(result));
    },
  );

  app.delete(
    '/api/v1/areas/:id',
    {
      onRequest: [app.authenticate],
      preHandler: [app.drawRateLimit('area.delete')],
      config: { auditAction: 'area.delete' },
      schema: {
        summary: 'Soft-delete an area (creator or admin)',
        tags: TAGS,
        security: SECURITY_BEARER,
        params: AreaIdParamsSchema,
        querystring: DeleteAreaQuerySchema,
        response: withProblems({ 200: AreaMutationResponseSchema }, 401, 403, 404, 409, 428),
      },
    },
    async (request, reply) => {
      const result = await service.remove(areasActor(request), request.params.id, request.query.baseVersion);
      return reply.code(200).header('ETag', versionEtag(result.area.version)).send(mutationResponse(result));
    },
  );

  app.post(
    '/api/v1/areas/:id/restore',
    {
      onRequest: [app.authenticate],
      preHandler: [app.drawRateLimit('area.restore')],
      config: { auditAction: 'area.restore' },
      schema: {
        summary: 'Restore a soft-deleted area (creator or admin)',
        tags: TAGS,
        security: SECURITY_BEARER,
        params: AreaIdParamsSchema,
        body: RestoreAreaRequestSchema,
        response: withProblems({ 200: AreaMutationResponseSchema }, 401, 403, 404, 409, 413, 415, 428),
      },
    },
    async (request, reply) => {
      const result = await service.restore(areasActor(request), request.params.id, request.body.baseVersion);
      return reply.code(200).header('ETag', versionEtag(result.area.version)).send(mutationResponse(result));
    },
  );
}
