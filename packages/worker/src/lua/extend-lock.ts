import { defineScript, type CommandParser } from "redis";

import type { QueueKeys } from "@panqueue/core";

import type { PanqueueRedisScript } from "./types.js";

/** Non-key arguments for the extend-lock script. */
export interface ExtendLockArgs {
  jobId: string;
  /** Lock token held by the caller; fences against stalled recovery. */
  lockToken: string;
  /** Lease duration in milliseconds. */
  leaseMs: number;
  /** The queue's hash-tag prefix, used to build the per-job key in Lua. */
  tag: string;
}

type ExtendLockScriptArguments = [keys: QueueKeys, args: ExtendLockArgs];

export type ExtendLockScript = PanqueueRedisScript<ExtendLockScriptArguments>;

/**
 * Lua script that atomically extends the lease deadline on an active job.
 *
 * 1. If the job hash is gone, return "missing".
 * 2. If its lockToken does not match the caller's token, return "stale".
 * 3. Compute a new deadline from Redis TIME.
 * 4. ZADD XX active newDeadline jobId — only updates if the job is still in
 *    the active ZSET. If recovery removed it, XX makes the ZADD a no-op and
 *    we return "stale".
 * 5. Update leaseDeadline on the hash and return "extended".
 *
 * Returns "extended", "stale", or "missing".
 */
export const EXTEND_LOCK_SCRIPT: ExtendLockScript = defineScript({
  NUMBER_OF_KEYS: 1,
  SCRIPT: `
local jobKey = ARGV[4] .. ':job:' .. ARGV[1]
if redis.call('EXISTS', jobKey) == 0 then
  return 'missing'
end

if redis.call('HGET', jobKey, 'lockToken') ~= ARGV[2] then
  return 'stale'
end

local t = redis.call('TIME')
local now = tonumber(t[1]) * 1000 + math.floor(tonumber(t[2]) / 1000)
local newDeadline = now + tonumber(ARGV[3])

redis.call('ZADD', KEYS[1], 'XX', 'CH', newDeadline, ARGV[1])
-- 'CH' returns 1 if score changed; 0 if not present or unchanged. A "not
-- present" outcome is what we care about: ensure ZSCORE confirms presence.
local score = redis.call('ZSCORE', KEYS[1], ARGV[1])
if not score then
  return 'stale'
end

redis.call('HSET', jobKey, 'leaseDeadline', newDeadline)
return 'extended'
`,
  /**
   * KEYS[1] = active; ARGV[1..4] = jobId, lockToken, leaseMs, tag.
   *
   * @param parser - command parser (injected by node-redis)
   * @param keys   - the queue's key bundle
   * @param args   - {@link ExtendLockArgs}
   */
  parseCommand(parser: CommandParser, keys: QueueKeys, args: ExtendLockArgs): void {
    parser.pushKeys([keys.active]);
    parser.push(args.jobId, args.lockToken, args.leaseMs.toString(), args.tag);
  },
  transformReply(reply: unknown): unknown {
    return reply;
  },
});
