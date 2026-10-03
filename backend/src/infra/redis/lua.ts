/**
 * A Lua script run with EVALSHA and a transparent EVAL fallback when Redis does not know the script yet (fresh
 * server, SCRIPT FLUSH, failover). Every multi-step Redis operation of the backend is one script, i.e. atomic.
 */
import { createHash } from 'node:crypto';

import type { Redis } from 'ioredis';

export class LuaScript {
  readonly source: string;
  readonly sha1: string;

  constructor(source: string) {
    this.source = source;
    this.sha1 = createHash('sha1').update(source).digest('hex');
  }

  async run(client: Redis, keys: readonly string[], args: readonly (string | number)[]): Promise<unknown> {
    try {
      return await client.evalsha(this.sha1, keys.length, ...keys, ...args);
    } catch (error) {
      if (!(error instanceof Error) || !error.message.startsWith('NOSCRIPT')) throw error;
      return client.eval(this.source, keys.length, ...keys, ...args);
    }
  }
}
