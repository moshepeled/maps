/**
 * Typed application errors (SPEC section 3.5). Services and hooks throw these; `problem.ts` turns them into RFC 9457
 * problem documents. The HTTP status always comes from the shared catalog, so client and server agree on it.
 */
import { ERRORS } from '@snapland/shared';
import type { ErrorCode, GeometryIssue, RateLimitScope } from '@snapland/shared';

export interface AppErrorOptions {
  /** Extension members of the problem document (e.g. `retryAfterMs`, `current`, `conflictingFields`). */
  extensions?: Record<string, unknown>;
  /** Response headers (e.g. `Retry-After`). */
  headers?: Record<string, string>;
  cause?: unknown;
}

export class AppError extends Error {
  readonly code: ErrorCode;
  readonly status: number;
  readonly detail: string;
  readonly extensions: Readonly<Record<string, unknown>>;
  readonly headers: Readonly<Record<string, string>>;

  constructor(code: ErrorCode, detail: string, options: AppErrorOptions = {}) {
    super(detail, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = new.target.name;
    this.code = code;
    this.status = ERRORS[code].status;
    this.detail = detail;
    this.extensions = options.extensions ?? {};
    this.headers = options.headers ?? {};
  }
}

/** One entry of a problem's `errors[]`. */
export interface FieldError {
  path: string;
  code: string;
  message: string;
  [extension: string]: unknown;
}

/** 400 VALIDATION_FAILED, e.g. a name that is empty after sanitisation (costs a drawing action, section 6.3). */
export class ValidationError extends AppError {
  constructor(detail: string, errors: readonly FieldError[] = []) {
    super('VALIDATION_FAILED', detail, { extensions: { errors } });
  }
}

export type UnauthorizedCode =
  | 'UNAUTHENTICATED'
  | 'TOKEN_INVALID'
  | 'TOKEN_EXPIRED'
  | 'INVALID_CREDENTIALS'
  | 'REFRESH_TOKEN_INVALID'
  | 'REFRESH_TOKEN_REUSED'
  | 'SESSION_REVOKED';

export class UnauthorizedError extends AppError {
  constructor(code: UnauthorizedCode, detail = 'Authentication failed.') {
    super(code, detail);
  }
}

export type ForbiddenCode = 'FORBIDDEN' | 'ACCOUNT_DISABLED' | 'ORIGIN_NOT_ALLOWED';

export class ForbiddenError extends AppError {
  constructor(
    code: ForbiddenCode = 'FORBIDDEN',
    detail = 'You are not allowed to do this.',
    options: AppErrorOptions = {},
  ) {
    super(code, detail, options);
  }
}

export type NotFoundCode = 'NOT_FOUND' | 'AREA_NOT_FOUND' | 'VERSION_NOT_FOUND';

export class NotFoundError extends AppError {
  constructor(code: NotFoundCode = 'NOT_FOUND', detail = 'Not found.') {
    super(code, detail);
  }
}

export type ConflictCode =
  'USERNAME_TAKEN' | 'VERSION_CONFLICT' | 'AREA_DELETED' | 'AREA_NOT_DELETED' | 'AREA_ID_CONFLICT';

export class ConflictError extends AppError {
  constructor(code: ConflictCode, detail: string, extensions: Record<string, unknown> = {}) {
    super(code, detail, { extensions });
  }
}

/** 422 INVALID_GEOMETRY with the section 9.2 sub-codes in `errors[]`. */
export class InvalidGeometryError extends AppError {
  constructor(issues: readonly GeometryIssue[], detail?: string) {
    super('INVALID_GEOMETRY', detail ?? issues[0]?.message ?? 'The geometry is invalid.', {
      extensions: { errors: issues },
    });
  }
}

/** 428: PATCH / DELETE / restore without `baseVersion`. */
export class PreconditionRequiredError extends AppError {
  constructor(detail = 'baseVersion is required for this operation.') {
    super('PRECONDITION_REQUIRED', detail);
  }
}

/** 429 with `scope`, `limit`, `retryAfterMs` and a `Retry-After` header (ceil seconds). */
export class RateLimitedError extends AppError {
  readonly scope: RateLimitScope;
  readonly retryAfterMs: number;

  constructor({
    scope,
    limit,
    retryAfterMs,
    detail,
  }: {
    scope: RateLimitScope;
    limit: number;
    retryAfterMs: number;
    detail?: string;
  }) {
    const retryAfter = Math.max(0, Math.ceil(retryAfterMs));
    super(
      'RATE_LIMITED',
      detail ?? `Rate limit exceeded (${scope}). Retry in ${Math.ceil(retryAfter / 1000)} s.`,
      {
        extensions: { scope, limit, retryAfterMs: retryAfter },
        headers: { 'Retry-After': String(Math.ceil(retryAfter / 1000)) },
      },
    );
    this.scope = scope;
    this.retryAfterMs = retryAfter;
  }
}

/** 503 DEPENDENCY_UNAVAILABLE (DB unreachable, pool exhausted, Redis failure) with `Retry-After: 5`. */
export class DependencyUnavailableError extends AppError {
  constructor(detail = 'A dependency is unavailable.', cause?: unknown) {
    super('DEPENDENCY_UNAVAILABLE', detail, { headers: { 'Retry-After': '5' }, cause });
  }
}

/** 503 REQUEST_TIMEOUT: the route safety net fired or a statement timed out. */
export class RequestTimeoutError extends AppError {
  constructor(detail = 'The request took too long.', cause?: unknown) {
    super('REQUEST_TIMEOUT', detail, { cause });
  }
}

/** 503 SERVICE_UNAVAILABLE (shutting down, no capacity), with `Retry-After` when a retry delay is known. */
export class ServiceUnavailableError extends AppError {
  constructor(detail = 'Service unavailable.', retryAfterS?: number) {
    super(
      'SERVICE_UNAVAILABLE',
      detail,
      retryAfterS === undefined ? {} : { headers: { 'Retry-After': String(Math.ceil(retryAfterS)) } },
    );
  }
}

/** 400 errors raised by domain parsers of bounded transport strings (bbox, cursor). */
export class BadRequestError extends AppError {
  // eslint-disable-next-line @typescript-eslint/no-useless-constructor -- narrows the accepted codes to the 400 parsers
  constructor(code: 'INVALID_BBOX' | 'INVALID_CURSOR', detail: string) {
    super(code, detail);
  }
}
