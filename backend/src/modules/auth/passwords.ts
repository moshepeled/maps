/**
 * Password hashing (SPEC section 6.2): argon2id via `@node-rs/argon2` with the OWASP baseline parameters. Unknown usernames
 * are verified against a precomputed dummy hash with the SAME parameters, so the response time of a login does not
 * reveal which usernames exist.
 */
import { hash as argon2Hash, verify as argon2Verify } from '@node-rs/argon2';
import type { Options as Argon2Options } from '@node-rs/argon2';

/**
 * OWASP baseline for argon2id (memory 19,456 KiB, 2 passes, parallelism 1). The algorithm is the library default
 * (argon2id, version 0x13); it is not passed explicitly because `Algorithm` is an ambient const enum (unusable under
 * isolatedModules). `passwords.test.ts` asserts the produced PHC string is `$argon2id$v=19$m=19456,t=2,p=1$...`.
 */
export const ARGON2_PARAMS = {
  memoryCost: 19_456,
  timeCost: 2,
  parallelism: 1,
} as const satisfies Argon2Options;

/** argon2id hash of a random, discarded password, computed once offline with ARGON2_PARAMS (checked by the test). */
export const DUMMY_PASSWORD_HASH =
  '$argon2id$v=19$m=19456,t=2,p=1$IecwtWQYbeKnNMLt1V74DA$c+2esL0HfHtK+1zu9l4MSUT5yyFo5pReN8nIOiOTAww';

export interface PasswordHasher {
  /** argon2id PHC string with ARGON2_PARAMS (a fresh random salt per call). */
  hash(password: string): Promise<string>;
  /** Constant-time comparison inside the binding; the parameters come from the stored PHC string. */
  verify(passwordHash: string, password: string): Promise<boolean>;
  /** Spends the time of a real verification for a username that does not exist; always false. */
  verifyDummy(password: string): Promise<false>;
}

export function createPasswordHasher(): PasswordHasher {
  return {
    hash: (password) => argon2Hash(password, ARGON2_PARAMS),
    verify: (passwordHash, password) => argon2Verify(passwordHash, password),
    async verifyDummy(password) {
      await argon2Verify(DUMMY_PASSWORD_HASH, password);
      return false;
    },
  };
}
