/**
 * Client-generated identifiers. Draft ids double as the id of the area they become (SPEC section 6.3), so they must be
 * UUIDv4 exactly like the server's.
 */

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** A random UUIDv4 from the platform CSPRNG. */
export function newId(): string {
  return crypto.randomUUID();
}

export function isUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID_PATTERN.test(value);
}

/** Monotonic correlation refs for WebSocket requests (`c-1`, `c-2`, ...; SPEC section 7.3). */
export function createRefGenerator(prefix = 'c'): () => string {
  let counter = 0;
  return () => {
    counter += 1;
    return `${prefix}-${counter}`;
  };
}
