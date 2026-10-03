/**
 * @snapland/shared - the public API of the contracts shared by backend and frontend (ADR-0001). Consumers import only
 * from this entry point; the package's only other export, `@snapland/shared/testing`, holds test fixtures.
 */
export * from './constants.js';
export * from './errors.js';
export * from './text/sanitize.js';

export * from './geo/types.js';
export * from './geo/precision.js';
export * from './geo/normalize.js';
export * from './geo/segments.js';
export * from './geo/geodesic.js';
export * from './geo/validate.js';
export * from './geo/bbox.js';
export * from './geo/webmercator.js';
export * from './geo/tiles.js';
export * from './geo/lod.js';

export * from './schemas/common.js';
export * from './schemas/auth.js';
export * from './schemas/areas.js';
export * from './schemas/presence.js';
export * from './schemas/config.js';
export * from './schemas/problem.js';
export * from './schemas/client-errors.js';
export * from './schemas/health.js';
export * from './schemas/admin.js';

export * from './protocol/close-codes.js';
export * from './protocol/envelope.js';
export * from './protocol/client-messages.js';
export * from './protocol/server-messages.js';
