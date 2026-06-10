import { defineScript, type CommandParser } from "redis";

import type { QueueKeys } from "@panqueue/core";

import type { PanqueueRedisScript } from "./types.js";

/** Non-key arguments for the fail script. */
export interface FailArgs {
  jobId: string;
  /** Error message recorded on the job. */
  error: string;
  /** Lock token held by the caller; fences against stalled recovery. */
  lockToken: string;
  /** The queue's hash-tag prefix, used to build the per-job key in Lua. */
  tag: string;
}

type FailScriptArguments = [keys: QueueKeys, args: FailArgs];

export type FailScript = PanqueueRedisScript<FailScriptArguments>;

/**
 * Lua script that atomically handles a job failure with retry support:
 * 1. If the job hash is gone, return "missing"; if its lockToken does not match
 *    the caller's token, return "stale" without changing state.
 * 2. ZREM the job ID from the active ZSET
 * 3. HINCRBY failures and record handler failure metadata.
 * 4. If failures <= maxRetries: re-queue (LPUSH to waiting, PUBLISH notify)
 * 5. Else: move to failed ZSET scored by finishedAt.
 *
 * Returns "waiting" (retried), "failed" (exhausted), "stale", or "missing".
 */
export const FAIL_SCRIPT: FailScript = defineScript({
  NUMBER_OF_KEYS: 4,
  SCRIPT: `
local jobKey = ARGV[4] .. ':job:' .. ARGV[1]
if redis.call('EXISTS', jobKey) == 0 then
  return 'missing'
end

if redis.call('HGET', jobKey, 'lockToken') ~= ARGV[3] then
  return 'stale'
end

local t = redis.call('TIME')
local now = tonumber(t[1]) * 1000 + math.floor(tonumber(t[2]) / 1000)

redis.call('ZREM', KEYS[1], ARGV[1])

local failures = redis.call('HINCRBY', jobKey, 'failures', 1)
redis.call('HSET', jobKey,
  'failureKind', 'handler',
  'failedReason', ARGV[2],
  'lastError', ARGV[2],
  'lastFailedAt', now)
redis.call('HDEL', jobKey, 'lockToken', 'leaseDeadline')

local maxRetries = tonumber(redis.call('HGET', jobKey, 'maxRetries')) or 0

if failures <= maxRetries then
  redis.call('HSET', jobKey, 'status', 'waiting')
  redis.call('LPUSH', KEYS[3], ARGV[1])
  redis.call('PUBLISH', KEYS[4], ARGV[1])
  return 'waiting'
else
  redis.call('HSET', jobKey, 'status', 'failed', 'finishedAt', now)
  redis.call('ZADD', KEYS[2], now, ARGV[1])
  return 'failed'
end
`,
  /**
   * KEYS[1..4] = active, failed, waiting, notify;
   * ARGV[1..4] = jobId, error, lockToken, tag.
   *
   * @param parser - command parser (injected by node-redis)
   * @param keys   - the queue's key bundle
   * @param args   - {@link FailArgs}
   */
  parseCommand(parser: CommandParser, keys: QueueKeys, args: FailArgs): void {
    parser.pushKeys([keys.active, keys.failed, keys.waiting, keys.notify]);
    parser.push(args.jobId, args.error, args.lockToken, args.tag);
  },
  transformReply(reply: unknown): unknown {
    return reply;
  },
});
