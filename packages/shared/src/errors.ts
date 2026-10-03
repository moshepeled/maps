/**
 * Error code catalog (SPEC section 3.5), used by REST problem+json responses and WebSocket `error` messages.
 * `code` is the stable identifier clients switch on; its HTTP status and problem title live next to it so both sides
 * agree.
 */

/** REST (and shared REST/WS) error codes with their HTTP status and problem title. */
export const ERRORS = {
  VALIDATION_FAILED: { status: 400, title: 'Validation failed' },
  INVALID_CURSOR: { status: 400, title: 'Invalid cursor' },
  INVALID_BBOX: { status: 400, title: 'Invalid bounding box' },
  UNAUTHENTICATED: { status: 401, title: 'Authentication required' },
  TOKEN_INVALID: { status: 401, title: 'Invalid token' },
  TOKEN_EXPIRED: { status: 401, title: 'Token expired' },
  INVALID_CREDENTIALS: { status: 401, title: 'Invalid credentials' },
  REFRESH_TOKEN_INVALID: { status: 401, title: 'Invalid refresh token' },
  REFRESH_TOKEN_REUSED: { status: 401, title: 'Refresh token reused' },
  SESSION_REVOKED: { status: 401, title: 'Session revoked' },
  ACCOUNT_DISABLED: { status: 403, title: 'Account disabled' },
  FORBIDDEN: { status: 403, title: 'Forbidden' },
  ORIGIN_NOT_ALLOWED: { status: 403, title: 'Origin not allowed' },
  NOT_FOUND: { status: 404, title: 'Not found' },
  AREA_NOT_FOUND: { status: 404, title: 'Area not found' },
  VERSION_NOT_FOUND: { status: 404, title: 'Version not found' },
  USERNAME_TAKEN: { status: 409, title: 'Username taken' },
  VERSION_CONFLICT: { status: 409, title: 'Version conflict' },
  AREA_DELETED: { status: 409, title: 'Area deleted' },
  AREA_NOT_DELETED: { status: 409, title: 'Area not deleted' },
  AREA_ID_CONFLICT: { status: 409, title: 'Area id conflict' },
  CHANGE_FEED_EXPIRED: { status: 410, title: 'Change feed expired' },
  PAYLOAD_TOO_LARGE: { status: 413, title: 'Payload too large' },
  UNSUPPORTED_MEDIA_TYPE: { status: 415, title: 'Unsupported media type' },
  INVALID_GEOMETRY: { status: 422, title: 'Invalid geometry' },
  PRECONDITION_REQUIRED: { status: 428, title: 'Precondition required' },
  RATE_LIMITED: { status: 429, title: 'Rate limited' },
  INTERNAL_ERROR: { status: 500, title: 'Internal error' },
  DEPENDENCY_UNAVAILABLE: { status: 503, title: 'Dependency unavailable' },
  REQUEST_TIMEOUT: { status: 503, title: 'Request timeout' },
  SERVICE_UNAVAILABLE: { status: 503, title: 'Service unavailable' },
} as const;

export type ErrorCode = keyof typeof ERRORS;

export const ERROR_CODES = Object.keys(ERRORS) as ErrorCode[];

/** Every code a WebSocket `error` may carry: the WS-only ones plus the shared REST codes it reuses. */
export type WsErrorCode =
  | ErrorCode
  | 'UNKNOWN_MESSAGE_TYPE'
  | 'MALFORMED_JSON'
  | 'THROTTLED'
  | 'DRAFT_NOT_FOUND'
  | 'DRAFT_ID_IN_USE'
  | 'LOCK_HELD'
  | 'LOCK_UNAVAILABLE'
  | 'LOCK_LIMIT_REACHED';

/** Sub-codes in `errors[].code` of INVALID_GEOMETRY, also produced by the client-side validator (section 3.5, section 9.2). */
export type GeometryErrorCode =
  | 'INVALID_GEOMETRY_TYPE'
  | 'NON_FINITE_COORDINATE'
  | 'COORDINATE_OUT_OF_RANGE'
  | 'RING_NOT_CLOSED'
  | 'TOO_FEW_POSITIONS'
  | 'TOO_MANY_VERTICES'
  | 'TOO_MANY_RINGS'
  | 'ANTIMERIDIAN_CROSSING'
  | 'EXTENT_TOO_LARGE'
  | 'SELF_INTERSECTION'
  | 'HOLE_OUTSIDE_SHELL'
  | 'HOLES_INTERSECT'
  | 'AREA_TOO_SMALL'
  | 'AREA_TOO_LARGE'
  | 'GEOS_INVALID';

/** Scopes reported in RATE_LIMITED problems and `ratelimit.hit` audit rows (section 3.5, section 10.1). */
export type RateLimitScope = 'draw' | 'api' | 'auth' | 'refresh' | 'login' | 'client_errors' | 'ws_upgrade';

/** `urn:snapland:problem:<kebab-case code>` (section 3.5). */
export function problemType(code: ErrorCode): string {
  return `urn:snapland:problem:${code.toLowerCase().replaceAll('_', '-')}`;
}
