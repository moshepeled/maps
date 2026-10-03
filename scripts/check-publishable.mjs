// @ts-check
// Publishability check (SPEC section 1.8 S1, section 10.7.7): fails when the tree a commit would contain has a .env file, a private
// key, a crash dump or a secret-looking value. Node built-ins only: it runs before `npm ci`.
import { spawnSync } from 'node:child_process';
import { readFileSync, statSync } from 'node:fs';
import { basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
/** The committed placeholder of .env.example; any other JWT_SECRET value in a publishable file is a leak. */
const JWT_SECRET_PLACEHOLDER = 'replace-me-run-node-scripts-setup-env-mjs';
/** Larger files (fixtures, images) are not scanned for secrets. */
const MAX_SCAN_BYTES = 1024 * 1024;

/**
 * Why a file must not be published: its name rules first, then its content.
 * @param {string} path repo-relative path
 * @param {string} content
 * @returns {string[]} empty when the file is fine
 */
export function secretProblems(path, content) {
  const name = basename(path);
  if (name.endsWith('.stackdump')) return ['crash dump (*.stackdump)'];
  if (name === '.env' || (name.startsWith('.env.') && name !== '.env.example')) {
    return ['environment file with secrets'];
  }
  if (/\.(pem|key|p12|pfx)$/i.test(name) || /^id_(rsa|ed25519|ecdsa)$/.test(name))
    return ['private key file'];

  const problems = [];
  if (/-----BEGIN (?:[A-Z]+ )?PRIVATE KEY-----/.test(content)) problems.push('private key');
  if (/\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{16,}/.test(content)) {
    problems.push('JWT-looking token');
  }
  const secrets = [...content.matchAll(/^\s*JWT_SECRET=([^\s"'`]+)/gm)].map((match) => match[1]);
  if (secrets.some((value) => value !== JWT_SECRET_PLACEHOLDER))
    problems.push('JWT_SECRET with a real value');
  return problems;
}

/**
 * Text of a file to scan; empty for binaries (a NUL byte), oversized or unreadable files.
 * @param {string} path
 * @returns {string}
 */
function readText(path) {
  try {
    if (statSync(path).size > MAX_SCAN_BYTES) return '';
    const bytes = readFileSync(path);
    return bytes.includes(0) ? '' : bytes.toString('utf8');
  } catch {
    return '';
  }
}

function main() {
  // Tracked + untracked minus ignored: the files a commit would contain. Works before the first commit.
  const git = spawnSync('git', ['ls-files', '-co', '--exclude-standard', '-z'], {
    cwd: ROOT,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  if (git.status !== 0) {
    console.error('check-publishable: git ls-files failed:', git.error ?? git.stderr);
    process.exitCode = 1;
    return;
  }
  let problems = 0;
  for (const path of git.stdout.split('\0').filter((entry) => entry !== '')) {
    for (const reason of secretProblems(path, readText(join(ROOT, path)))) {
      console.error(`check-publishable: ${path}: ${reason}`);
      problems += 1;
    }
  }
  if (problems > 0) process.exitCode = 1;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
