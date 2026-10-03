import { parseOptions, verify } from '@node-rs/argon2';
import { describe, expect, it, vi } from 'vitest';

import { ARGON2_PARAMS, DUMMY_PASSWORD_HASH, createPasswordHasher } from './passwords.js';

vi.mock('@node-rs/argon2', async (importOriginal) => {
  const m = await importOriginal<{ verify: typeof verify }>();
  return { ...m, verify: vi.fn(m.verify) };
});

/** PHC prefix of argon2id, version 0x13, with the OWASP baseline parameters. */
const EXPECTED_PREFIX = '$argon2id$v=19$m=19456,t=2,p=1$';

describe('password hashing (section 6.2)', () => {
  it('hashes with argon2id m=19456 t=2 p=1 and a fresh salt per call', async () => {
    const hasher = createPasswordHasher();
    const first = await hasher.hash('correct horse battery staple');
    const second = await hasher.hash('correct horse battery staple');
    expect(first.startsWith(EXPECTED_PREFIX)).toBe(true);
    expect(second).not.toBe(first);
  });

  it('verifies the right password and rejects a wrong one', async () => {
    const hasher = createPasswordHasher();
    const stored = await hasher.hash('s3cret-password');
    await expect(hasher.verify(stored, 's3cret-password')).resolves.toBe(true);
    await expect(hasher.verify(stored, 's3cret-passwore')).resolves.toBe(false);
  });

  it('keeps the dummy hash on exactly the production parameters (same verification cost)', () => {
    expect(DUMMY_PASSWORD_HASH.startsWith(EXPECTED_PREFIX)).toBe(true);
    const parsed = parseOptions(DUMMY_PASSWORD_HASH);
    expect({
      memoryCost: parsed.memoryCost,
      timeCost: parsed.timeCost,
      parallelism: parsed.parallelism,
    }).toEqual(ARGON2_PARAMS);
    expect(parsed.outputLen).toBe(32);
    expect(parsed.saltLen).toBe(16);
  });

  it('verifyDummy really verifies against the dummy hash and always answers false', async () => {
    vi.mocked(verify).mockClear();
    await expect(createPasswordHasher().verifyDummy('anything')).resolves.toBe(false);
    expect(verify).toHaveBeenCalledWith(DUMMY_PASSWORD_HASH, 'anything');
  });
});
