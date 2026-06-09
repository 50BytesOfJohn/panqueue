import { defineScript, type CommandParser } from "redis";

import type { QueueKeys } from "@panqueue/core";

import type { PanqueueRedisScript } from "./types.js";

/** Non-key arguments for the requeue-active script. */
export interface RequeueActiveArgs {
  jobId: string;
  /** Lock token held by the caller; fences against stalled recovery. */
  lockToken: string;
  /** lastRequeueReason text written on the job hash. */
  reason: string;
}

type RequeueActiveScriptArguments = [keys: QueueKeys, args: RequeueActiveArgs];

export type RequeueActiveScript = PanqueueRedisScript<RequeueActiveScriptArguments>;

/**
 * Lua script used by force shutdown to atomically hand an in-flight job
 * back to the queue without waiting for its lease to expire.
 *
 * Force shutdown is an ownership handoff, not a handler failure or stall.
 *
 * 1. HGET the job hash; if missing, return "missing".
 * 2. If the stored lockToken does not match the caller's, return "stale"
 *    (recovery already grabbed it — nothing to requeue).
 * 3. ZREM the job from the active ZSET. Clear lockToken/leaseDeadline.
 * 4. Record lastRequeuedAt/lastRequeueReason, mark waiting, LPUSH, PUBLISH.
 *
 * Returns "waiting", "stale", "missing", or "corrupt".
 */
export const REQUEUE_ACTIVE_SCRIPT: RequeueActiveScript = defineScript({
  NUMBER_OF_KEYS: 6,
  SCRIPT: `
local raw = redis.call('HGET', KEYS[3], ARGV[1])
if not raw then
  return 'missing'
end

local ok, job = pcall(cjson.decode, raw)
local t = redis.call('TIME')
local now = tonumber(t[1]) * 1000 + math.floor(tonumber(t[2]) / 1000)

if not ok then
  redis.call('ZADD', KEYS[5], now, ARGV[1])
  redis.call('HSET', KEYS[6], ARGV[1], cjson.encode({
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

job['lockToken'] = nil
job['leaseDeadline'] = nil
job['lastRequeuedAt'] = now
job['lastRequeueReason'] = ARGV[3]
job['status'] = 'waiting'

redis.call('HSET', KEYS[3], ARGV[1], cjson.encode(job))
redis.call('LPUSH', KEYS[2], ARGV[1])
redis.call('PUBLISH', KEYS[4], ARGV[1])
return 'waiting'
`,
  /**
   * KEYS[1..6] = active, waiting, jobs, notify, corrupt, corruptData;
   * ARGV[1..3] = jobId, lockToken, reason.
   *
   * @param parser - command parser (injected by node-redis)
   * @param keys   - the queue's key bundle
   * @param args   - {@link RequeueActiveArgs}
   */
  parseCommand(parser: CommandParser, keys: QueueKeys, args: RequeueActiveArgs): void {
    parser.pushKeys([
      keys.active,
      keys.waiting,
      keys.jobs,
      keys.notify,
      keys.corrupt,
      keys.corruptData,
    ]);
    parser.push(args.jobId, args.lockToken, args.reason);
  },
  transformReply(reply: unknown): unknown {
    return reply;
  },
});
