/**
 * Collaborator colour (SPEC section 6.2): `USER_PALETTE[fnv1a32(userId) mod 12]`. Derived from the id, so it is stable and
 * needs no coordination between instances; the shared `constants.test.ts` keeps `USER_PALETTE` in step with tokens.css.
 */
import { USER_PALETTE } from '@snapland/shared';
import type { UserColor } from '@snapland/shared';

const FNV_OFFSET_BASIS_32 = 0x811c9dc5;
const FNV_PRIME_32 = 0x01000193;

const utf8 = new TextEncoder();

/** 32-bit FNV-1a over the UTF-8 bytes of `input`, as an unsigned integer. */
export function fnv1a32(input: string): number {
  let hash = FNV_OFFSET_BASIS_32;
  for (const byte of utf8.encode(input)) {
    hash ^= byte;
    // Math.imul keeps the multiplication in 32-bit integer arithmetic (a float product would lose the low bits).
    hash = Math.imul(hash, FNV_PRIME_32);
  }
  return hash >>> 0;
}

/** The palette colour of a user id (lowercase `#rrggbb`, the `users_color_ck` format). */
export function colorForUser(userId: string): UserColor {
  const index = fnv1a32(userId.toLowerCase()) % USER_PALETTE.length;
  // The index is always in range; the fallback only satisfies noUncheckedIndexedAccess.
  return USER_PALETTE[index] ?? USER_PALETTE[0];
}
