/**
 * Soft locks in Redis (SPEC section 7.9): one HASH `<p>locks`, field `<areaId>` = the lock record JSON, with a per-field TTL
 * (`HPEXPIRE`, hash-field expiration of Redis >= 7.4). One hash makes the late joiners' `lock.snapshot` a single
 * `HGETALL`. Acquire and release are Lua scripts (compare-and-set). Every method throws on Redis failures.
 */
import { BboxSchema, HexColorSchema, IsoDateTimeSchema, UuidSchema } from '@snapland/shared';
import type { Redis } from 'ioredis';
import { z } from 'zod';

import type { RedisKeys } from '../../infra/redis/keys.js';
import { LuaScript } from '../../infra/redis/lua.js';

export const LockRecordSchema = z.object({
  userId: UuidSchema,
  displayName: z.string(),
  color: HexColorSchema,
  scope: z.enum(['geometry', 'details']),
  connectionId: UuidSchema,
  instanceId: z.string(),
  bbox: BboxSchema,
  acquiredAt: IsoDateTimeSchema,
  /** acquire/renew time + REALTIME_LOCK_TTL_MS (the field TTL is set to the same value). */
  expiresAt: IsoDateTimeSchema,
});

export type LockRecord = z.infer<typeof LockRecordSchema>;

/**
 * KEYS[1] locks, ARGV[1] areaId, ARGV[2] userId, ARGV[3] record JSON, ARGV[4] TTL ms.
 * Free, or held by the same user (another tab) -> set/renew and return {1}; else {0, current record JSON}.
 */
const ACQUIRE = new LuaScript(`
local current = redis.call('HGET', KEYS[1], ARGV[1])
if current then
  local ok, record = pcall(cjson.decode, current)
  if ok and record.userId ~= ARGV[2] then
    return {0, current}
  end
end
redis.call('HSET', KEYS[1], ARGV[1], ARGV[3])
redis.call('HPEXPIRE', KEYS[1], ARGV[4], 'FIELDS', 1, ARGV[1])
return {1}
`);

/** KEYS[1] locks, ARGV[1] areaId, ARGV[2] connectionId -> 1 when this connection's lock was deleted. */
const RELEASE = new LuaScript(`
local current = redis.call('HGET', KEYS[1], ARGV[1])
if not current then return 0 end
local ok, record = pcall(cjson.decode, current)
if ok and record.connectionId ~= ARGV[2] then return 0 end
redis.call('HDEL', KEYS[1], ARGV[1])
return 1
`);

export type AcquireResult = { acquired: true } | { acquired: false; holder: LockRecord | null };

export function parseLockRecord(raw: string): LockRecord | null {
  try {
    const parsed = LockRecordSchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

export class LockStore {
  readonly #redis: Redis;
  readonly #keys: RedisKeys;

  constructor(redis: Redis, keys: RedisKeys) {
    this.#redis = redis;
    this.#keys = keys;
  }

  async acquire(areaId: string, record: LockRecord, ttlMs: number): Promise<AcquireResult> {
    const result = await ACQUIRE.run(
      this.#redis,
      [this.#keys.locks()],
      [areaId, record.userId, JSON.stringify(record), ttlMs],
    );
    if (!Array.isArray(result)) throw new Error('unexpected lock acquire reply');
    if (Number(result[0]) === 1) return { acquired: true };
    return { acquired: false, holder: parseLockRecord(String(result[1])) };
  }

  async release(areaId: string, connectionId: string): Promise<boolean> {
    return (await RELEASE.run(this.#redis, [this.#keys.locks()], [areaId, connectionId])) === 1;
  }

  /** Every live lock (expired fields are already gone), keyed by area id. */
  async all(): Promise<Map<string, LockRecord>> {
    const raw = await this.#redis.hgetall(this.#keys.locks());
    const locks = new Map<string, LockRecord>();
    for (const [areaId, value] of Object.entries(raw)) {
      const record = parseLockRecord(value);
      if (record !== null) locks.set(areaId, record);
    }
    return locks;
  }
}
