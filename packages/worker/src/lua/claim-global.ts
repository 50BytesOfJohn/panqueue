import { defineScript, type CommandParser } from "redis";

import type { QueueKeys } from "@panqueue/core";

import type { PanqueueRedisScript } from "./types.js";

/** Non-key arguments for the claim-global script. */
export interface ClaimGlobalArgs {
  /** Lease duration in milliseconds. */
  leaseMs: number;
}

type ClaimGlobalScriptArguments = [keys: QueueKeys, args: ClaimGlobalArgs];

export type ClaimGlobalScript = PanqueueRedisScript<ClaimGlobalScriptArguments>;

/**
 * Lua script that atomically claims a job from the waiting list (global mode):
 * 1. RPOP a job ID from the waiting list
 * 2. HGET and safely decode the job data
 * 3. ZADD the job ID into the active ZSET scored by Redis-time lease deadline
 * 4. Generate a fresh lockToken and set active lifecycle metadata
 * 5. Return the updated job JSON
 *
 * Returns the updated job JSON string, or nil if the waiting list is empty.
 * Returns "corrupt:<jobId>" when the stored payload cannot be decoded.
 */
export const CLAIM_GLOBAL_SCRIPT: ClaimGlobalScript = defineScript({
  NUMBER_OF_KEYS: 5,
  SCRIPT: `
local jobId = redis.call('RPOP', KEYS[1])
if not jobId then
  return nil
end

local raw = redis.call('HGET', KEYS[3], jobId)
if not raw then
  return redis.error_reply('PANQUEUE_MISSING_JOB_DATA: ' .. jobId)
end

local ok, job = pcall(cjson.decode, raw)
if not ok then
  local t = redis.call('TIME')
  local detectedAt = tonumber(t[1]) * 1000 + math.floor(tonumber(t[2]) / 1000)
  redis.call('ZADD', KEYS[4], detectedAt, jobId)
  redis.call('HSET', KEYS[5], jobId, cjson.encode({
    jobId = jobId,
    reason = 'invalid-json',
    detectedAt = detectedAt,
    raw = string.sub(raw, 1, 4096)
  }))
  return 'corrupt:' .. jobId
end

local t = redis.call('TIME')
local now = tonumber(t[1]) * 1000 + math.floor(tonumber(t[2]) / 1000)
local leaseMs = tonumber(ARGV[1])
local deadline = now + leaseMs

job['status'] = 'active'
job['lastStartedAt'] = now
job['runs'] = (job['runs'] or 0) + 1

local token = redis.sha1hex(jobId .. ':' .. tostring(now) .. ':' .. tostring(job['runs']))
job['lockToken'] = token
job['leaseDeadline'] = deadline

redis.call('ZADD', KEYS[2], deadline, jobId)
local updated = cjson.encode(job)
redis.call('HSET', KEYS[3], jobId, updated)

return updated
`,
  /**
   * KEYS[1..5] = waiting, active, jobs, corrupt, corruptData; ARGV[1] = leaseMs.
   *
   * @param parser - command parser (injected by node-redis)
   * @param keys   - the queue's key bundle
   * @param args   - {@link ClaimGlobalArgs}
   */
  parseCommand(parser: CommandParser, keys: QueueKeys, args: ClaimGlobalArgs): void {
    parser.pushKeys([keys.waiting, keys.active, keys.jobs, keys.corrupt, keys.corruptData]);
    parser.push(args.leaseMs.toString());
  },
  transformReply(reply: unknown): unknown {
    return reply;
  },
});
