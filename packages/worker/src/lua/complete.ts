import { defineScript, type CommandParser } from "redis";

import type { QueueKeys } from "@panqueue/core";

import type { PanqueueRedisScript } from "./types.js";

/** Non-key arguments for the complete script. */
export interface CompleteArgs {
  jobId: string;
  /** Lock token held by the caller; fences against stalled recovery. */
  lockToken: string;
}

type CompleteScriptArguments = [keys: QueueKeys, args: CompleteArgs];

export type CompleteScript = PanqueueRedisScript<CompleteScriptArguments>;

/**
 * Lua script that atomically marks a job as completed:
 * 1. HGET the job hash; if its lockToken does not match the caller's token,
 *    return "stale" without changing state (the lease was lost to recovery).
 * 2. ZREM the job ID from the active ZSET
 * 3. ZADD the job ID to the completed index scored by Redis finishedAt
 * 4. Update the job data with status="completed", finishedAt, and clear lock fields
 *
 * Returns "completed", "stale", "missing", or "corrupt".
 */
export const COMPLETE_SCRIPT: CompleteScript = defineScript({
  NUMBER_OF_KEYS: 5,
  SCRIPT: `
local raw = redis.call('HGET', KEYS[3], ARGV[1])
if not raw then
  return 'missing'
end

local ok, job = pcall(cjson.decode, raw)
local t = redis.call('TIME')
local now = tonumber(t[1]) * 1000 + math.floor(tonumber(t[2]) / 1000)

if not ok then
  redis.call('ZADD', KEYS[4], now, ARGV[1])
  redis.call('HSET', KEYS[5], ARGV[1], cjson.encode({
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

redis.call('ZREM', KEYS[1], ARGV[1])
redis.call('ZADD', KEYS[2], now, ARGV[1])

job['status'] = 'completed'
job['finishedAt'] = now
job['lockToken'] = nil
job['leaseDeadline'] = nil
redis.call('HSET', KEYS[3], ARGV[1], cjson.encode(job))

return 'completed'
`,
  /**
   * KEYS[1..5] = active, completed, jobs, corrupt, corruptData;
   * ARGV[1..2] = jobId, lockToken.
   *
   * @param parser - command parser (injected by node-redis)
   * @param keys   - the queue's key bundle
   * @param args   - {@link CompleteArgs}
   */
  parseCommand(parser: CommandParser, keys: QueueKeys, args: CompleteArgs): void {
    parser.pushKeys([keys.active, keys.completed, keys.jobs, keys.corrupt, keys.corruptData]);
    parser.push(args.jobId, args.lockToken);
  },
  transformReply(reply: unknown): unknown {
    return reply;
  },
});
