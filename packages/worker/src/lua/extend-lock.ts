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
}

type ExtendLockScriptArguments = [keys: QueueKeys, args: ExtendLockArgs];

export type ExtendLockScript = PanqueueRedisScript<ExtendLockScriptArguments>;

/**
 * Lua script that atomically extends the lease deadline on an active job.
 *
 * 1. HGET and safely decode the job hash.
 * 2. If its lockToken does not match the caller's token, return "stale".
 * 3. Compute a new deadline from Redis TIME.
 * 4. ZADD XX active newDeadline jobId — only updates if the job is still in
 *    the active ZSET. If recovery removed it, XX makes the ZADD a no-op and
 *    we return "stale".
 * 5. Update leaseDeadline on the hash and return "extended".
 *
 * Returns "extended", "stale", "missing", or "corrupt".
 */
export const EXTEND_LOCK_SCRIPT: ExtendLockScript = defineScript({
  NUMBER_OF_KEYS: 4,
  SCRIPT: `
local raw = redis.call('HGET', KEYS[2], ARGV[1])
if not raw then
  return 'missing'
end

local ok, job = pcall(cjson.decode, raw)
local t = redis.call('TIME')
local now = tonumber(t[1]) * 1000 + math.floor(tonumber(t[2]) / 1000)

if not ok then
  redis.call('ZADD', KEYS[3], now, ARGV[1])
  redis.call('HSET', KEYS[4], ARGV[1], cjson.encode({
    jobId = ARGV[1],
    reason = 'invalid-json',
    detectedAt = now,
    raw = string.sub(raw, 1, 4096)
  }))
  return 'corrupt'
end

if job['lockToken'] ~= ARGV[2] then
  return 'stale'
end

local leaseMs = tonumber(ARGV[3])
local newDeadline = now + leaseMs
redis.call('ZADD', KEYS[1], 'XX', 'CH', newDeadline, ARGV[1])
-- 'CH' returns 1 if score changed; 0 if not present or unchanged. A "not
-- present" outcome is what we care about: ensure ZSCORE confirms presence.
local score = redis.call('ZSCORE', KEYS[1], ARGV[1])
if not score then
  return 'stale'
end

job['leaseDeadline'] = newDeadline
redis.call('HSET', KEYS[2], ARGV[1], cjson.encode(job))
return 'extended'
`,
  /**
   * KEYS[1..4] = active, jobs, corrupt, corruptData;
   * ARGV[1..3] = jobId, lockToken, leaseMs.
   *
   * @param parser - command parser (injected by node-redis)
   * @param keys   - the queue's key bundle
   * @param args   - {@link ExtendLockArgs}
   */
  parseCommand(parser: CommandParser, keys: QueueKeys, args: ExtendLockArgs): void {
    parser.pushKeys([keys.active, keys.jobs, keys.corrupt, keys.corruptData]);
    parser.push(args.jobId, args.lockToken, args.leaseMs.toString());
  },
  transformReply(reply: unknown): unknown {
    return reply;
  },
});
