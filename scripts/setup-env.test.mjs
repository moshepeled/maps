// @ts-check
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { createEnv } from './setup-env.mjs';

const EXAMPLE = 'NODE_ENV=development\nJWT_SECRET=replace-me-run-node-scripts-setup-env-mjs\nPORT=3100\n';

/** @type {string[]} */
const roots = [];

/** @param {Record<string, string>} files */
function tempRoot(files) {
  const root = mkdtempSync(join(tmpdir(), 'snapland-setup-env-'));
  roots.push(root);
  for (const [name, content] of Object.entries(files)) writeFileSync(join(root, name), content);
  return root;
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('setup-env', () => {
  it('creates .env with a 48-byte secret in place of the placeholder', () => {
    const root = tempRoot({ '.env.example': EXAMPLE });
    expect(createEnv(root)).toBe(true);
    const env = readFileSync(join(root, '.env'), 'utf8');
    const secret = /^JWT_SECRET=(\S+)$/m.exec(env)?.[1] ?? '';
    expect(Buffer.from(secret, 'base64url')).toHaveLength(48);
    expect(env).not.toContain('replace-me');
    expect(env).toContain('PORT=3100');
  });

  it('never overwrites an existing .env', () => {
    const root = tempRoot({ '.env.example': EXAMPLE, '.env': 'KEEP=mine\n' });
    expect(createEnv(root)).toBe(false);
    expect(createEnv(root)).toBe(false);
    expect(readFileSync(join(root, '.env'), 'utf8')).toBe('KEEP=mine\n');
  });

  it('fails when .env.example is missing or has no JWT_SECRET line', () => {
    expect(() => createEnv(tempRoot({}))).toThrow(/ENOENT/);
    expect(() => createEnv(tempRoot({ '.env.example': 'PORT=1\n' }))).toThrow(/JWT_SECRET/);
  });
});
