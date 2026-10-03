// @ts-check
// R45 dependency audit (SPEC section 1.7, section 3.4): walks the installed tree (`npm ls --all --json`, transitive packages
// included) and fails when any package is a third-party collaboration or drawing plugin.
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

/** Package names and globs (`*` matches anything but `/`). */
const BANNED = [
  'yjs',
  'y-*',
  '@y-*/*',
  '@hocuspocus/*',
  'automerge',
  '@automerge/*',
  'sharedb',
  'liveblocks',
  '@liveblocks/*',
  'partykit',
  'partysocket',
  'replicache',
  'pusher-js',
  'ably',
  '@supabase/realtime-js',
  'socket.io',
  'socket.io-client',
  'socket.io-*',
  'leaflet-draw',
  'leaflet.pm',
  'leaflet-editable',
  'leaflet-geoman-free',
  '@geoman-io/leaflet-geoman-free',
  '@geoman-io/*',
];

/** @param {string} glob */
function globToRegex(glob) {
  const escaped = glob.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/]*');
  return new RegExp(`^${escaped}$`);
}

const BANNED_REGEXES = BANNED.map(globToRegex);

/** @typedef {{ version?: string; dependencies?: Record<string, NpmTreeNode> }} NpmTreeNode */

/**
 * Depth-first walk of an `npm ls --json` tree: every banned package as `name@version (dependency path)`.
 * @param {NpmTreeNode} root
 * @returns {string[]}
 */
export function findBanned(root) {
  /** @type {string[]} */
  const findings = [];
  /** @type {Set<NpmTreeNode>} */
  const seen = new Set();
  /**
   * @param {NpmTreeNode} node
   * @param {string[]} trail
   */
  const visit = (node, trail) => {
    if (seen.has(node)) return;
    seen.add(node);
    for (const [name, child] of Object.entries(node.dependencies ?? {})) {
      const path = [...trail, name];
      if (BANNED_REGEXES.some((regex) => regex.test(name))) {
        findings.push(`${name}@${child.version ?? 'unknown'} (${path.join(' > ')})`);
      }
      visit(child, path);
    }
  };
  visit(root, []);
  return findings;
}

function main() {
  // npm exits non-zero for unrelated tree problems (extraneous packages) but still prints the tree.
  const npm = spawnSync('npm', ['ls', '--all', '--json'], {
    cwd: fileURLToPath(new URL('..', import.meta.url)),
    encoding: 'utf8',
    maxBuffer: 256 * 1024 * 1024,
    shell: process.platform === 'win32',
  });
  /** @type {unknown} */
  let tree;
  try {
    tree = JSON.parse(npm.stdout);
  } catch {
    tree = null;
  }
  if (typeof tree !== 'object' || tree === null) {
    console.error(
      `check-banned-deps: npm ls did not return JSON (exit ${npm.status})`,
      npm.error ?? npm.stderr,
    );
    process.exitCode = 1;
    return;
  }
  const findings = findBanned(/** @type {NpmTreeNode} */ (tree));
  for (const finding of findings)
    console.error(`check-banned-deps: banned package installed (R45): ${finding}`);
  if (findings.length > 0) process.exitCode = 1;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
