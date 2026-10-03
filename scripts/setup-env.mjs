// @ts-check
// Creates .env from .env.example with a freshly generated JWT_SECRET (SPEC section 3.8, section 11.1). An existing .env is never
// overwritten. Node built-ins only: it runs before `npm ci`.
import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const JWT_SECRET_LINE = /^JWT_SECRET=.*$/m;

/**
 * Creates `<root>/.env` from `<root>/.env.example` with a 48-byte base64url secret.
 * @param {string} root
 * @returns {boolean} true when .env was created, false when it already existed
 */
export function createEnv(root) {
  const envPath = join(root, '.env');
  if (existsSync(envPath)) return false;
  const example = readFileSync(join(root, '.env.example'), 'utf8');
  if (!JWT_SECRET_LINE.test(example)) throw new Error('.env.example has no JWT_SECRET= line');
  const secret = randomBytes(48).toString('base64url');
  // 'wx' fails if .env appeared meanwhile, so a concurrent run can never overwrite it.
  writeFileSync(envPath, example.replace(JWT_SECRET_LINE, `JWT_SECRET=${secret}`), { flag: 'wx' });
  return true;
}

function main() {
  try {
    const created = createEnv(fileURLToPath(new URL('..', import.meta.url)));
    console.error(
      created ? 'setup-env: created .env with a generated JWT_SECRET' : 'setup-env: .env exists, unchanged',
    );
  } catch (error) {
    console.error(`setup-env: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
