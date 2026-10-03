/**
 * Redis draft registry (SPEC section 7.6): `snap:draft:<draftId>` = JSON owner record with the resume-window TTL. Every
 * operation is one Lua script, so compare-and-set semantics hold across instances (a late close on instance A can
 * never delete a record that a resume on instance B took over).
 */
import { z } from 'zod';

import type { Clock } from '../clock.js';
import type { Logger } from '../logger.js';
import type { RedisClients } from '../redis/client.js';
import type { RedisKeys } from '../redis/keys.js';
import { LuaScript } from '../redis/lua.js';
import { KeyedThrottle } from '../keyed-throttle.js';
import { draftTouchIntervalMs } from './types.js';
import type { DraftClaimResult, DraftOwner, DraftRegistry, DraftResumeResult } from './types.js';

const OwnerSchema = z.object({
  userId: z.string(),
  sessionId: z.string(),
  connectionId: z.string(),
  instanceId: z.string(),
  state: z.enum(['active', 'disconnected']),
});

/** KEYS[1] draft key, ARGV[1] record JSON, ARGV[2] TTL seconds -> 1 claimed, 0 in use. */
const CLAIM = new LuaScript(`
if redis.call('SET', KEYS[1], ARGV[1], 'NX', 'EX', ARGV[2]) then return 1 end
return 0
`);

/**
 * KEYS[1], ARGV[1] userId, ARGV[2] sessionId, ARGV[3] new record JSON, ARGV[4] TTL -> 1 resumed, 0 not found.
 * Same user AND (same session OR a disconnected record): two live tabs never steal each other's draft.
 */
const RESUME = new LuaScript(`
local raw = redis.call('GET', KEYS[1])
if not raw then return 0 end
local record = cjson.decode(raw)
if record.userId ~= ARGV[1] then return 0 end
if record.sessionId ~= ARGV[2] and record.state ~= 'disconnected' then return 0 end
redis.call('SET', KEYS[1], ARGV[3], 'EX', ARGV[4])
return 1
`);

/** KEYS[1], ARGV[1] connectionId, ARGV[2] TTL -> 1 when refreshed. */
const TOUCH = new LuaScript(`
local raw = redis.call('GET', KEYS[1])
if not raw then return 0 end
if cjson.decode(raw).connectionId ~= ARGV[1] then return 0 end
redis.call('EXPIRE', KEYS[1], ARGV[2])
return 1
`);

/** KEYS[1], ARGV[1] connectionId -> 1 when deleted. */
const RELEASE = new LuaScript(`
local raw = redis.call('GET', KEYS[1])
if not raw then return 0 end
if cjson.decode(raw).connectionId ~= ARGV[1] then return 0 end
redis.call('DEL', KEYS[1])
return 1
`);

/** KEYS[1], ARGV[1] connectionId, ARGV[2] TTL -> 1 when marked disconnected. */
const MARK_DISCONNECTED = new LuaScript(`
local raw = redis.call('GET', KEYS[1])
if not raw then return 0 end
local record = cjson.decode(raw)
if record.connectionId ~= ARGV[1] then return 0 end
record.state = 'disconnected'
redis.call('SET', KEYS[1], cjson.encode(record), 'EX', ARGV[2])
return 1
`);

/** Touches are throttled per owning connection: a foreign touch must not delay the owner's refresh. */
function touchKey(draftId: string, connectionId: string): string {
  return `${draftId}:${connectionId}`;
}

export interface RedisDraftRegistryDeps {
  redis: RedisClients;
  keys: RedisKeys;
  clock: Clock;
  logger: Logger;
  /** REALTIME_DRAFT_RESUME_WINDOW_S */
  resumeWindowS: number;
}

export class RedisDraftRegistry implements DraftRegistry {
  readonly #deps: RedisDraftRegistryDeps;
  readonly #throttle: KeyedThrottle;
  readonly #logger: Logger;

  constructor(deps: RedisDraftRegistryDeps) {
    this.#deps = deps;
    this.#throttle = new KeyedThrottle(draftTouchIntervalMs(deps.resumeWindowS));
    this.#logger = deps.logger.child({ component: 'draft-registry' });
  }

  async claim(draftId: string, owner: Omit<DraftOwner, 'state'>): Promise<DraftClaimResult> {
    const record: DraftOwner = { ...owner, state: 'active' };
    const result = await CLAIM.run(
      this.#cmd(),
      [this.#deps.keys.draft(draftId)],
      [JSON.stringify(record), this.#deps.resumeWindowS],
    );
    return result === 1 ? 'claimed' : 'in_use';
  }

  async resume(draftId: string, owner: Omit<DraftOwner, 'state'>): Promise<DraftResumeResult> {
    const record: DraftOwner = { ...owner, state: 'active' };
    const result = await RESUME.run(
      this.#cmd(),
      [this.#deps.keys.draft(draftId)],
      [owner.userId, owner.sessionId, JSON.stringify(record), this.#deps.resumeWindowS],
    );
    return result === 1 ? 'resumed' : 'not_found';
  }

  async touch(draftId: string, connectionId: string): Promise<void> {
    if (!this.#throttle.shouldFire(touchKey(draftId, connectionId), this.#deps.clock.now())) return;
    try {
      await TOUCH.run(
        this.#cmd(),
        [this.#deps.keys.draft(draftId)],
        [connectionId, this.#deps.resumeWindowS],
      );
    } catch (error) {
      this.#throttle.forget(touchKey(draftId, connectionId));
      this.#logger.warn({ err: error, draftId }, 'draft touch failed');
    }
  }

  async release(draftId: string, connectionId: string): Promise<boolean> {
    this.#throttle.forget(touchKey(draftId, connectionId));
    try {
      return (await RELEASE.run(this.#cmd(), [this.#deps.keys.draft(draftId)], [connectionId])) === 1;
    } catch (error) {
      this.#logger.warn({ err: error, draftId }, 'draft release failed (the record expires with its TTL)');
      return false;
    }
  }

  async markDisconnected(draftId: string, connectionId: string): Promise<boolean> {
    this.#throttle.forget(touchKey(draftId, connectionId));
    try {
      const result = await MARK_DISCONNECTED.run(
        this.#cmd(),
        [this.#deps.keys.draft(draftId)],
        [connectionId, this.#deps.resumeWindowS],
      );
      return result === 1;
    } catch (error) {
      this.#logger.warn({ err: error, draftId }, 'draft markDisconnected failed');
      return false;
    }
  }

  async getOwner(draftId: string): Promise<DraftOwner | null> {
    try {
      const raw = await this.#cmd().get(this.#deps.keys.draft(draftId));
      if (raw === null) return null;
      const parsed = OwnerSchema.safeParse(JSON.parse(raw));
      return parsed.success ? parsed.data : null;
    } catch (error) {
      // Fail-open (section 7.6): availability over strictness while Redis is down.
      this.#logger.warn({ err: error, draftId }, 'draft owner lookup failed; treating as unowned');
      return null;
    }
  }

  #cmd() {
    return this.#deps.redis.cmd;
  }
}
