/**
 * "PostgreSQL is not reachable right now": the same statement will succeed once it is back. Covers SQLSTATE class 08
 * (connection exception) and 53 (insufficient resources, e.g. 53300 too_many_connections), the 57P0x server
 * shutdown states, Node socket errors, and the connection failures node-postgres reports only through the message.
 */
import { pgErrorCode } from './execute.js';

const CONNECTION_CODES = new Set([
  '57P01', // admin_shutdown
  '57P02', // crash_shutdown
  '57P03', // cannot_connect_now
  'ECONNREFUSED',
  'ECONNRESET',
  'ETIMEDOUT',
  'EPIPE',
  'ENOTFOUND',
  'EHOSTUNREACH',
  'EAI_AGAIN',
]);

const CONNECTION_MESSAGES = [
  'Connection terminated',
  'timeout exceeded when trying to connect',
  'Client has encountered a connection error',
];

export function isConnectionFailure(error: unknown): boolean {
  const code = pgErrorCode(error);
  if (code.startsWith('08') || code.startsWith('53') || CONNECTION_CODES.has(code)) return true;
  const message = error instanceof Error ? error.message : '';
  return CONNECTION_MESSAGES.some((fragment) => message.includes(fragment));
}
