/**
 * The single canonical form of a username (SPEC section 6.2: usernames are case-insensitive). Registration accepts only
 * `LIMITS.usernamePattern` (an ASCII handle or an ASCII email address, D-8), so every stored name is ASCII. A name is
 * folded HERE, once, and that one value keys both the login failure counters and the account lookup
 * (`lower(username) = $1`, with no second fold of the input): JavaScript and PostgreSQL fold some non-ASCII letters
 * differently, and folding in two places once let one account be reached through several counter keys. A name
 * outside the pattern cannot belong to any account, so it never reaches SQL (which also keeps U+0000 out of text
 * parameters).
 */
import { LIMITS } from '@snapland/shared';

declare const canonicalUsernameBrand: unique symbol;

/** A username that matches the registration pattern, lower-cased. Only `canonicalUsername` creates one. */
export type CanonicalUsername = string & { readonly [canonicalUsernameBrand]: true };

/** No `g` flag: `test` must stay stateless across calls. */
const USERNAME_PATTERN = new RegExp(LIMITS.usernamePattern);

/**
 * The canonical form of `raw`, or null when no account can have that name. The pattern admits ASCII only, so
 * `toLowerCase` maps exactly A-Z to a-z here: no locale or Unicode rule is involved.
 */
export function canonicalUsername(raw: string): CanonicalUsername | null {
  if (!USERNAME_PATTERN.test(raw)) return null;
  // The one place that creates the brand: `raw` has just been checked against the pattern.
  return raw.toLowerCase() as CanonicalUsername;
}
