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
}

type FailScriptArguments = [keys: QueueKeys, args: FailArgs];

export type FailScript = PanqueueRedisScript<FailScriptArguments>;

/**
 * Lua script that atomically handles a job failure with retry support:
 * 1. HGET the job hash; if its lockToken does not match the caller's token,
 *    return "stale" without changing state.
 * 2. ZREM the job ID from the active ZSET
 * 3. Increment failures and record handler failure metadata.
 * 4. If failures <= maxRetries: re-queue (LPUSH to waiting, PUBLISH notify)
 * 5. Else: move to failed ZSET scored by finishedAt.
 *
 * Returns "waiting" (retried), "failed" (exhausted), "stale", "missing",
 * or "corrupt".
 */
export const FAIL_SCRIPT: FailScript = defineScript({
  NUMBER_OF_KEYS: 7,
  SCRIPT: `
local raw = redis.call('HGET', KEYS[4], ARGV[1])
if not raw then
  return 'missing'
end

local ok, job = pcall(cjson.decode, raw)
local t = redis.call('TIME')
local now = tonumber(t[1]) * 1000 + math.floor(tonumber(t[2]) / 1000)

if not ok then
  redis.call('ZADD', KEYS[6], now, ARGV[1])
  redis.call('HSET', KEYS[7], ARGV[1], cjson.encode({
    jobId = ARGV[1],
    reason = 'invalid-json',
    detectedAt = now,
    raw = string.sub(raw, 1, 4096)
  }))
  return 'corrupt'
end

if job['lockToken'] ~= ARGV[3] then
  return 'stale'
end

redis.call('ZREM', KEYS[1], ARGV[1])

job['failures'] = (job['failures'] or 0) + 1
job['failureKind'] = 'handler'
job['failedReason'] = ARGV[2]
job['lastError'] = ARGV[2]
job['lastFailedAt'] = now
job['lockToken'] = nil
job['leaseDeadline'] = nil

local maxRetries = job['maxRetries'] or 0

if job['failures'] <= maxRetries then
  job['status'] = 'waiting'
  redis.call('HSET', KEYS[4], ARGV[1], cjson.encode(job))
  redis.call('LPUSH', KEYS[3], ARGV[1])
  redis.call('PUBLISH', KEYS[5], ARGV[1])
  return 'waiting'
else
  job['status'] = 'failed'
  job['finishedAt'] = now
  redis.call('HSET', KEYS[4], ARGV[1], cjson.encode(job))
  redis.call('ZADD', KEYS[2], now, ARGV[1])
  return 'failed'
end
`,
  /**
   * KEYS[1..7] = active, failed, waiting, jobs, notify, corrupt, corruptData;
   * ARGV[1..3] = jobId, error, lockToken.
   *
   * @param parser - command parser (injected by node-redis)
   * @param keys   - the queue's key bundle
   * @param args   - {@link FailArgs}
   */
  parseCommand(parser: CommandParser, keys: QueueKeys, args: FailArgs): void {
    parser.pushKeys([
      keys.active,
      keys.failed,
      keys.waiting,
      keys.jobs,
      keys.notify,
      keys.corrupt,
      keys.corruptData,
    ]);
    parser.push(args.jobId, args.error, args.lockToken);
  },
  transformReply(reply: unknown): unknown {
    return reply;
  },
});
