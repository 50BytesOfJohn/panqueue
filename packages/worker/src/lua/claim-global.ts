import { defineScript, type CommandParser } from "redis";

import type { QueueKeys } from "@panqueue/core";

import type { PanqueueRedisScript } from "./types.js";

/** Non-key arguments for the claim-global script. */
export interface ClaimGlobalArgs {
  /** Lease duration in milliseconds. */
  leaseMs: number;
  /** The queue's hash-tag prefix, used to build the per-job key in Lua. */
  tag: string;
}

type ClaimGlobalScriptArguments = [keys: QueueKeys, args: ClaimGlobalArgs];

export type ClaimGlobalScript = PanqueueRedisScript<ClaimGlobalScriptArguments>;

/**
 * Lua script that atomically claims a job from the waiting list (global mode):
 * 1. RPOP a job ID from the waiting list
 * 2. HINCRBY the run counter and HSET active lifecycle fields on the job hash
 * 3. Generate a fresh lockToken and ZADD into the active ZSET by lease deadline
 * 4. Return the full job hash via HGETALL
 *
 * Returns the job hash as a flat `[field, value, …]` array, `nil` if the
 * waiting list is empty, or `{'corrupt', jobId}` when the waiting-list
 * pointer survived but its job hash is gone (unrecoverable). The payload
 * field is returned verbatim — Lua never decodes it.
 */
export const CLAIM_GLOBAL_SCRIPT: ClaimGlobalScript = defineScript({
  NUMBER_OF_KEYS: 2,
  SCRIPT: `
local jobId = redis.call('RPOP', KEYS[1])
if not jobId then
  return nil
end

local jobKey = ARGV[2] .. ':job:' .. jobId
if redis.call('EXISTS', jobKey) == 0 then
  return {'corrupt', jobId}
end

local t = redis.call('TIME')
local now = tonumber(t[1]) * 1000 + math.floor(tonumber(t[2]) / 1000)
local deadline = now + tonumber(ARGV[1])

local runs = redis.call('HINCRBY', jobKey, 'runs', 1)
local token = redis.sha1hex(jobId .. ':' .. tostring(now) .. ':' .. tostring(runs))

redis.call('HSET', jobKey,
  'status', 'active',
  'lastStartedAt', now,
  'lockToken', token,
  'leaseDeadline', deadline)
redis.call('ZADD', KEYS[2], deadline, jobId)

return redis.call('HGETALL', jobKey)
`,
  /**
   * KEYS[1..2] = waiting, active; ARGV[1..2] = leaseMs, tag.
   *
   * @param parser - command parser (injected by node-redis)
   * @param keys   - the queue's key bundle
   * @param args   - {@link ClaimGlobalArgs}
   */
  parseCommand(parser: CommandParser, keys: QueueKeys, args: ClaimGlobalArgs): void {
    parser.pushKeys([keys.waiting, keys.active]);
    parser.push(args.leaseMs.toString(), args.tag);
  },
  transformReply(reply: unknown): unknown {
    return reply;
  },
});
