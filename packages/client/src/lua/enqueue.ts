import { defineScript, type CommandParser } from "redis";

import type { QueueKeys } from "@panqueue/core";

import type { PanqueueRedisScript } from "./types.js";

/** Non-key arguments for the enqueue script. */
export interface EnqueueArgs {
  jobId: string;
  /** Opaque, pre-serialized user payload (JSON string). Lua never decodes it. */
  payload: string;
  /** The queue this job belongs to. */
  queueId: string;
  /** Maximum number of handler retries after the first failure. */
  maxRetries: number;
  /** Maximum number of stalled lease recoveries before terminal failure. */
  maxStalls: number;
  /** The queue's hash-tag prefix, used to build the per-job key in Lua. */
  tag: string;
}

type EnqueueScriptArguments = [keys: QueueKeys, args: EnqueueArgs];

export type EnqueueScript = PanqueueRedisScript<EnqueueScriptArguments>;

/**
 * Lua script that atomically enqueues a job:
 * 1. HSETNX the job's `id` field into its per-job hash (atomic collision check)
 * 2. HSET the opaque payload and discrete lifecycle fields
 * 3. LPUSH the job ID onto the waiting list
 * 4. PUBLISH a notification on the notify channel
 *
 * The payload is stored verbatim — Lua never decodes it, so user data is never
 * mangled by cjson.
 *
 * Returns the job ID.
 */
export const ENQUEUE_SCRIPT: EnqueueScript = defineScript({
  NUMBER_OF_KEYS: 2,
  SCRIPT: `
local jobKey = ARGV[6] .. ':job:' .. ARGV[1]
local t = redis.call('TIME')
local now = tonumber(t[1]) * 1000 + math.floor(tonumber(t[2]) / 1000)

if redis.call('HSETNX', jobKey, 'id', ARGV[1]) == 0 then
  return redis.error_reply('PANQUEUE_JOB_ID_COLLISION: ' .. ARGV[1])
end

redis.call('HSET', jobKey,
  'queueId', ARGV[3],
  'payload', ARGV[2],
  'status', 'waiting',
  'runs', 0,
  'failures', 0,
  'stalls', 0,
  'maxRetries', ARGV[4],
  'maxStalls', ARGV[5],
  'createdAt', now)

redis.call('LPUSH', KEYS[1], ARGV[1])
redis.call('PUBLISH', KEYS[2], ARGV[1])
return ARGV[1]
`,
  /**
   * KEYS[1..2] = waiting, notify;
   * ARGV[1..6] = jobId, payload, queueId, maxRetries, maxStalls, tag.
   *
   * @param parser - command parser (injected by node-redis)
   * @param keys   - the queue's key bundle
   * @param args   - {@link EnqueueArgs}
   */
  parseCommand(parser: CommandParser, keys: QueueKeys, args: EnqueueArgs): void {
    parser.pushKeys([keys.waiting, keys.notify]);
    parser.push(
      args.jobId,
      args.payload,
      args.queueId,
      args.maxRetries.toString(),
      args.maxStalls.toString(),
      args.tag,
    );
  },
  transformReply(reply: unknown): unknown {
    return reply;
  },
});
