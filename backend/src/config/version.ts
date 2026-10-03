/**
 * Application version reported by `/api/v1/config`, `/health/ready` and every log line. Kept equal to
 * `backend/package.json` `version` (asserted by `env.test.ts`) without importing JSON from outside `src/`.
 */
export const APP_VERSION = '1.0.0';

/** The `service` base field of every log line (section 3.6). */
export const SERVICE_NAME = 'snapland-backend';
