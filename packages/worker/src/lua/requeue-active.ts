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
  /** The queue's hash-tag prefix, used to build the per-job key in Lua. */
  tag: string;
}

type RequeueActiveScriptArguments = [keys: QueueKeys, args: RequeueActiveArgs];

export type RequeueActiveScript = PanqueueRedisScript<RequeueActiveScriptArguments>;

/**
 * Lua script used by force shutdown to atomically hand an in-flight job
 * back to the queue without waiting for its lease to expire.
 *
 * Force shutdown is an ownership handoff, not a handler failure or stall.
 *
 * 1. If the job hash is gone, return "missing".
 * 2. If the stored lockToken does not match the caller's, return "stale"
 *    (recovery already grabbed it — nothing to requeue).
 * 3. ZREM the job from the active ZSET. Clear lockToken/leaseDeadline.
 * 4. Record lastRequeuedAt/lastRequeueReason, mark waiting, LPUSH, PUBLISH.
 *
 * Returns "waiting", "stale", or "missing".
 */
export const REQUEUE_ACTIVE_SCRIPT: RequeueActiveScript = defineScript({
  NUMBER_OF_KEYS: 3,
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

redis.call('ZREM', KEYS[1], ARGV[1])

redis.call('HSET', jobKey,
  'lastRequeuedAt', now,
  'lastRequeueReason', ARGV[3],
  'status', 'waiting')
redis.call('HDEL', jobKey, 'lockToken', 'leaseDeadline')

redis.call('LPUSH', KEYS[2], ARGV[1])
redis.call('PUBLISH', KEYS[3], ARGV[1])
return 'waiting'
`,
  /**
   * KEYS[1..3] = active, waiting, notify;
   * ARGV[1..4] = jobId, lockToken, reason, tag.
   *
   * @param parser - command parser (injected by node-redis)
   * @param keys   - the queue's key bundle
   * @param args   - {@link RequeueActiveArgs}
   */
  parseCommand(parser: CommandParser, keys: QueueKeys, args: RequeueActiveArgs): void {
    parser.pushKeys([keys.active, keys.waiting, keys.notify]);
    parser.push(args.jobId, args.lockToken, args.reason, args.tag);
  },
  transformReply(reply: unknown): unknown {
    return reply;
  },
});
