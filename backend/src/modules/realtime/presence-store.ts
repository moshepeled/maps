/**
 * Presence registry in Redis (SPEC section 7.7): HASH `<p>presence:conns` (field connectionId -> PresenceDto JSON +
 * `instanceId`) and ZSET `<p>presence:seen` (member connectionId, score = last seen ms). Every multi-key operation is
 * one Lua script, so the two keys never disagree. Every method throws on Redis failures; the presence service decides
 * how to degrade.
 */
import { PresenceDtoSchema } from '@snapland/shared';
import type { PresenceDto } from '@snapland/shared';
import type { Redis } from 'ioredis';

import type { RedisKeys } from '../../infra/redis/keys.js';
import { LuaScript } from '../../infra/redis/lua.js';

/** KEYS[1] conns, KEYS[2] seen, ARGV[1] connectionId, ARGV[2] entry JSON, ARGV[3] now. */
const UPSERT = new LuaScript(`
redis.call('HSET', KEYS[1], ARGV[1], ARGV[2])
redis.call('ZADD', KEYS[2], ARGV[3], ARGV[1])
return 1
`);

/** KEYS[1] conns, KEYS[2] seen, ARGV[1] connectionId -> 1 when the entry existed. */
const REMOVE = new LuaScript(`
local removed = redis.call('HDEL', KEYS[1], ARGV[1])
redis.call('ZREM', KEYS[2], ARGV[1])
return removed
`);

/**
 * KEYS[1] conns, KEYS[2] seen, ARGV[1] now, then pairs (connectionId, entry JSON).
 * Marks every connection as seen and re-adds hash fields that a sweeper removed (e.g. after an event-loop stall);
 * returns the ids that were re-added, so the caller re-announces them.
 */
const REFRESH = new LuaScript(`
local readded = {}
for i = 2, #ARGV, 2 do
  local id = ARGV[i]
  redis.call('ZADD', KEYS[2], ARGV[1], id)
  if redis.call('HEXISTS', KEYS[1], id) == 0 then
    redis.call('HSET', KEYS[1], id, ARGV[i + 1])
    readded[#readded + 1] = id
  end
end
return readded
`);

/**
 * KEYS[1] conns, KEYS[2] seen, ARGV[1] cutoff (ms), ARGV[2] limit.
 * Removes entries not seen since the cutoff from both keys and returns them as (connectionId, entry JSON | '') pairs.
 * Atomic, so exactly one instance removes (and announces) each stale entry.
 */
const SWEEP = new LuaScript(`
local ids = redis.call('ZRANGEBYSCORE', KEYS[2], '-inf', ARGV[1], 'LIMIT', 0, tonumber(ARGV[2]))
local out = {}
for _, id in ipairs(ids) do
  local raw = redis.call('HGET', KEYS[1], id)
  redis.call('HDEL', KEYS[1], id)
  redis.call('ZREM', KEYS[2], id)
  out[#out + 1] = id
  out[#out + 1] = raw or ''
end
return out
`);

export interface SweptEntry {
  connectionId: string;
  presence: PresenceDto | null;
}

/** Stored entry: the PresenceDto plus the owning instance (the DTO schema strips `instanceId` on parse). */
export function serializeEntry(presence: PresenceDto, instanceId: string): string {
  return JSON.stringify({ ...presence, instanceId });
}

export function parseEntry(raw: string): PresenceDto | null {
  try {
    const parsed = PresenceDtoSchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

export class PresenceStore {
  readonly #redis: Redis;
  readonly #keys: RedisKeys;
  readonly #instanceId: string;

  constructor(redis: Redis, keys: RedisKeys, instanceId: string) {
    this.#redis = redis;
    this.#keys = keys;
    this.#instanceId = instanceId;
  }

  async upsert(presence: PresenceDto, now: number): Promise<void> {
    await UPSERT.run(this.#redis, this.#keyPair(), [
      presence.connectionId,
      serializeEntry(presence, this.#instanceId),
      now,
    ]);
  }

  async remove(connectionId: string): Promise<boolean> {
    return (await REMOVE.run(this.#redis, this.#keyPair(), [connectionId])) === 1;
  }

  /** Returns the connection ids whose hash field had to be re-added. */
  async refresh(entries: readonly PresenceDto[], now: number): Promise<string[]> {
    if (entries.length === 0) return [];
    const args: (string | number)[] = [now];
    for (const presence of entries) {
      args.push(presence.connectionId, serializeEntry(presence, this.#instanceId));
    }
    const result = await REFRESH.run(this.#redis, this.#keyPair(), args);
    return Array.isArray(result) ? result.map(String) : [];
  }

  async sweep(cutoff: number, limit: number): Promise<SweptEntry[]> {
    const result = await SWEEP.run(this.#redis, this.#keyPair(), [cutoff, limit]);
    if (!Array.isArray(result)) return [];
    const swept: SweptEntry[] = [];
    for (let index = 0; index + 1 < result.length; index += 2) {
      const raw = String(result[index + 1]);
      swept.push({ connectionId: String(result[index]), presence: raw === '' ? null : parseEntry(raw) });
    }
    return swept;
  }

  /** Every valid entry of the registry (invalid JSON is skipped). */
  async all(): Promise<PresenceDto[]> {
    const raw = await this.#redis.hvals(this.#keys.presenceConns());
    return raw.map(parseEntry).filter((entry): entry is PresenceDto => entry !== null);
  }

  #keyPair(): [string, string] {
    return [this.#keys.presenceConns(), this.#keys.presenceSeen()];
  }
}
