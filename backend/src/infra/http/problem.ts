/**
 * The single error and not-found handler (SPEC section 3.5): every non-2xx response is `application/problem+json`. Transport
 * (zod) validation failures are ALWAYS 400; driver errors are classified (statement timeout -> REQUEST_TIMEOUT,
 * connection loss -> DEPENDENCY_UNAVAILABLE, the geometry CHECK -> INVALID_GEOMETRY); anything unknown is a generic 500.
 * 5xx bodies never contain internals - the error is logged with `err` at `error` level instead.
 */
import { ERRORS, problemType } from '@snapland/shared';
import type { ErrorCode } from '@snapland/shared';
import type { FastifyError, FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { hasZodFastifySchemaValidationErrors, isResponseSerializationError } from 'fastify-type-provider-zod';

import { isConnectionFailure } from '../db/errors.js';
import { pgErrorCode } from '../db/execute.js';
import {
  AppError,
  DependencyUnavailableError,
  InvalidGeometryError,
  RequestTimeoutError,
  ValidationError,
} from './errors.js';
import type { FieldError } from './errors.js';

const PROBLEM_CONTENT_TYPE = 'application/problem+json; charset=utf-8';

export interface ProblemResponse {
  status: number;
  headers: Record<string, string>;
  body: Record<string, unknown>;
}

/** ioredis failures (fail-fast client: no offline queue, command timeout). */
const REDIS_FAILURE_MESSAGES = [
  'Command timed out',
  "Stream isn't writeable",
  'Connection is closed',
  'Reached the max retries per request limit',
];

function isGeometryCheckViolation(error: unknown): boolean {
  return (
    pgErrorCode(error) === '23514' &&
    typeof error === 'object' &&
    error !== null &&
    'constraint' in error &&
    error.constraint === 'areas_geom_valid_ck'
  );
}

/** The part of a Fastify validation error the mapping reads. */
type FastifyValidationFailure = Pick<FastifyError, 'validation' | 'validationContext'>;

function validationErrorFromFastify(error: FastifyValidationFailure): ValidationError {
  const context = error.validationContext ?? 'request';
  const fieldErrors: FieldError[] = (error.validation ?? []).map((issue) => ({
    path: [context, ...issue.instancePath.split('/').filter((segment) => segment !== '')].join('.'),
    code: issue.keyword,
    message: issue.message ?? 'is invalid',
  }));
  return new ValidationError(`Request ${context} is invalid.`, fieldErrors);
}

/** Maps any thrown value to the AppError that describes it to the client. */
export function toAppError(error: unknown): AppError {
  if (error instanceof AppError) return error;
  // Anything thrown that is not an object (a string, a number) can only be a programming error.
  if (typeof error !== 'object' || error === null)
    return new AppError('INTERNAL_ERROR', 'An unexpected error occurred.');
  if (isResponseSerializationError(error))
    return new AppError('INTERNAL_ERROR', 'Response serialization failed.', { cause: error });
  if (hasZodFastifySchemaValidationErrors(error)) return validationErrorFromFastify(error);

  const code = pgErrorCode(error);
  const message = error instanceof Error ? error.message : '';
  if (code === 'FST_ERR_VALIDATION' || 'validation' in error) return validationErrorFromFastify(error);
  if (code === 'FST_ERR_CTP_BODY_TOO_LARGE')
    return new AppError('PAYLOAD_TOO_LARGE', 'The request body is too large.');
  if (code === 'FST_ERR_CTP_INVALID_MEDIA_TYPE')
    return new AppError('UNSUPPORTED_MEDIA_TYPE', 'Only application/json is accepted.');
  if (
    code === 'FST_ERR_CTP_INVALID_JSON_BODY' ||
    code === 'FST_ERR_CTP_EMPTY_JSON_BODY' ||
    error instanceof SyntaxError
  ) {
    return new ValidationError('The request body is not valid JSON.', [
      { path: 'body', code: 'invalid_json', message: 'invalid JSON' },
    ]);
  }
  if (code === '57014' || message === 'Query read timeout') return new RequestTimeoutError(undefined, error);
  if (isGeometryCheckViolation(error)) {
    return new InvalidGeometryError([
      {
        code: 'GEOS_INVALID',
        message: 'PostgreSQL rejected the geometry (areas_geom_valid_ck).',
        path: 'geometry',
      },
    ]);
  }
  if (
    isConnectionFailure(error) ||
    REDIS_FAILURE_MESSAGES.some((fragment) => message.includes(fragment)) ||
    (error instanceof Error && error.name === 'MaxRetriesPerRequestError')
  ) {
    return new DependencyUnavailableError(undefined, error);
  }
  // Other Fastify client errors (bad content-length, malformed URL, ...) keep their 4xx meaning.
  const statusCode = 'statusCode' in error ? error.statusCode : undefined;
  if (typeof statusCode === 'number' && statusCode >= 400 && statusCode < 500) {
    return statusCode === 404
      ? new AppError('NOT_FOUND', 'Not found.')
      : new ValidationError(message || 'Bad request.');
  }
  return new AppError('INTERNAL_ERROR', 'An unexpected error occurred.', { cause: error });
}

/** Path of the request without its query string (the `instance` member). */
function instanceOf(request: FastifyRequest): string {
  const url = request.raw.url ?? request.url;
  const queryStart = url.indexOf('?');
  return queryStart === -1 ? url : url.slice(0, queryStart);
}

/** Builds the problem document and headers for an AppError. 5xx details are replaced by a generic reference text. */
export function buildProblem(appError: AppError, request: FastifyRequest): ProblemResponse {
  const status = appError.status;
  const code: ErrorCode = appError.code;
  const detail = status >= 500 ? `An unexpected error occurred. Reference: ${request.id}` : appError.detail;
  return {
    status,
    headers: { ...appError.headers },
    body: {
      type: problemType(code),
      title: ERRORS[code].title,
      status: ERRORS[code].status,
      code,
      detail,
      instance: instanceOf(request),
      requestId: request.id,
      ...appError.extensions,
    },
  };
}

export function sendProblem(reply: FastifyReply, problem: ProblemResponse): FastifyReply {
  return reply.code(problem.status).headers(problem.headers).type(PROBLEM_CONTENT_TYPE).send(problem.body);
}

/** Installs the error and not-found handlers on the root instance. */
export function registerProblemHandlers(app: FastifyInstance): void {
  app.setErrorHandler((error, request, reply) => {
    const appError = toAppError(error);
    request.problemCode = appError.code;
    if (appError.status >= 500) {
      request.log.error({ err: error, code: appError.code }, 'request failed');
    } else {
      request.log.debug({ code: appError.code, detail: appError.detail }, 'request rejected');
    }
    return sendProblem(reply, buildProblem(appError, request));
  });
  app.setNotFoundHandler((request, reply) => {
    request.problemCode = 'NOT_FOUND';
    return sendProblem(
      reply,
      buildProblem(new AppError('NOT_FOUND', `No route ${request.method} ${instanceOf(request)}.`), request),
    );
  });
}
