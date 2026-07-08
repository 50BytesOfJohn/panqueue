import { defineScript, type CommandParser } from "redis";

import type { QueueKeys } from "@panqueue/core";

import type { PanqueueRedisScript } from "./types.js";

/** Non-key arguments for the claim-global-batch script. */
export interface ClaimGlobalBatchArgs {
  /** Lease duration in milliseconds. */
  leaseMs: number;
  /** The queue's hash-tag prefix, used to build the per-job key in Lua. */
  tag: string;
  /** Maximum number of jobs to claim in this round trip. */
  count: number;
}

type ClaimGlobalBatchScriptArguments = [keys: QueueKeys, args: ClaimGlobalBatchArgs];

export type ClaimGlobalBatchScript = PanqueueRedisScript<ClaimGlobalBatchScriptArguments>;

/**
 * Lua script that atomically claims up to `count` jobs from the waiting list
 * (global mode) in a single round trip. `TIME` is read once and the resulting
 * `now`/`deadline` are shared across the whole batch — lockToken uniqueness
 * still holds because `runs` (from HINCRBY) differs per job.
 *
 * For each job, up to `count` times:
 * 1. RPOP a job ID from the waiting list; stop early if it is empty
 *    (a partial batch is normal, not an error).
 * 2. HINCRBY the run counter and HSET active lifecycle fields on the job hash.
 * 3. Generate a fresh lockToken and ZADD into the active ZSET by lease deadline.
 * 4. Append the full job hash (HGETALL flat array) to the output table.
 *
 * Returns an array of per-job entries: each entry is either a job hash as a
 * flat `[field, value, …]` array, or `{'corrupt', jobId}` when the waiting-list
 * pointer survived but its job hash is gone (unrecoverable). Returns an empty
 * table when the waiting list was already empty. Payload is returned verbatim —
 * Lua never decodes it.
 */
export const CLAIM_GLOBAL_BATCH_SCRIPT: ClaimGlobalBatchScript = defineScript({
  NUMBER_OF_KEYS: 2,
  SCRIPT: `
local count = tonumber(ARGV[3])
local t = redis.call('TIME')
local now = tonumber(t[1]) * 1000 + math.floor(tonumber(t[2]) / 1000)
local deadline = now + tonumber(ARGV[1])
local claimed = {}

for i = 1, count do
  local jobId = redis.call('RPOP', KEYS[1])
  if not jobId then
    break
  end

  local jobKey = ARGV[2] .. ':job:' .. jobId
  if redis.call('EXISTS', jobKey) == 0 then
    table.insert(claimed, {'corrupt', jobId})
  else
    local runs = redis.call('HINCRBY', jobKey, 'runs', 1)
    local token = redis.sha1hex(jobId .. ':' .. tostring(now) .. ':' .. tostring(runs))

    redis.call('HSET', jobKey,
      'status', 'active',
      'lastStartedAt', now,
      'lockToken', token,
      'leaseDeadline', deadline)
    redis.call('ZADD', KEYS[2], deadline, jobId)

    table.insert(claimed, redis.call('HGETALL', jobKey))
  end
end

return claimed
`,
  /**
   * KEYS[1..2] = waiting, active; ARGV[1..3] = leaseMs, tag, count.
   *
   * @param parser - command parser (injected by node-redis)
   * @param keys   - the queue's key bundle
   * @param args   - {@link ClaimGlobalBatchArgs}
   */
  parseCommand(parser: CommandParser, keys: QueueKeys, args: ClaimGlobalBatchArgs): void {
    parser.pushKeys([keys.waiting, keys.active]);
    parser.push(args.leaseMs.toString(), args.tag, args.count.toString());
  },
  transformReply(reply: unknown): unknown {
    return reply;
  },
});
