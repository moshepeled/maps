/**
 * `uniqueIp()` (SPEC section 12.2 isolation rule 1): every per-IP limit test uses its own `remoteAddress`
 * (`app.inject({ remoteAddress: uniqueIp() })`), so it never inherits hits from earlier files in the same 60 s window.
 * The second octet is derived from the run id, so parallel runs use disjoint address blocks as well.
 */
import { createHash, randomInt } from 'node:crypto';

/**
 * Each test file has its own module state, so the counter starts at a random offset: files of the same run then use
 * different addresses even within one 60 s rate-limit window.
 */
let counter = randomInt(0, 60_000);

function runOctet(): number {
  const runId = process.env['TEST_RUN_ID'] ?? 'local';
  const digest = createHash('sha256').update(runId).digest();
  return 1 + ((digest[0] ?? 0) % 254);
}

export function uniqueIp(): string {
  counter += 1;
  const high = Math.floor(counter / 254) % 254;
  const low = 1 + (counter % 253);
  return `10.${runOctet()}.${high}.${low}`;
}
