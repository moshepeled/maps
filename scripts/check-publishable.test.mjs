// @ts-check
import { describe, expect, it } from 'vitest';

import { secretProblems } from './check-publishable.mjs';

// Secret-looking fixtures are assembled at runtime so this test file never trips the real check itself.
const SECRET_KEY = 'JWT_' + 'SECRET';
const PLACEHOLDER = 'replace-me-run-node-scripts-setup-env-mjs';
const PRIVATE_KEY_HEADER = '-----BEGIN ' + 'PRIVATE KEY-----';
const JWT = ['eyJhbGciOiJIUzI1NiJ9', 'eyJzdWIiOiIxMjM0NTY3ODkwIn0', 'c2lnbmF0dXJlLXNpZ25hdHVyZS1zaWc'].join(
  '.',
);

describe('secretProblems', () => {
  it('accepts ordinary files and the .env.example placeholder', () => {
    expect(secretProblems('src/index.ts', 'export const a = 1;\n')).toEqual([]);
    expect(secretProblems('.env.example', `${SECRET_KEY}=${PLACEHOLDER}\n`)).toEqual([]);
    expect(secretProblems('notes.md', 'the header alone eyJhbGciOiJIUzI1NiJ9 is fine')).toEqual([]);
  });

  it('rejects .env files, key files and crash dumps by name', () => {
    expect(secretProblems('.env', '')).toEqual(['environment file with secrets']);
    expect(secretProblems('backend/.env.production', '')).toEqual(['environment file with secrets']);
    expect(secretProblems('certs/server.pem', '')).toEqual(['private key file']);
    expect(secretProblems('src/id_rsa', '')).toEqual(['private key file']);
    expect(secretProblems('bash.exe.stackdump', '')).toEqual(['crash dump (*.stackdump)']);
  });

  it('rejects secret-looking content', () => {
    expect(secretProblems('config.txt', `${SECRET_KEY}=my-real-production-secret-value\n`)).toEqual([
      'JWT_SECRET with a real value',
    ]);
    expect(secretProblems('notes.md', `${PRIVATE_KEY_HEADER}\nabc\n`)).toEqual(['private key']);
    expect(secretProblems('tokens.json', `{"token":"${JWT}"}`)).toEqual(['JWT-looking token']);
  });
});
