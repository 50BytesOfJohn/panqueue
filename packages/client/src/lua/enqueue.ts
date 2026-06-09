import { defineScript, type CommandParser } from "redis";

import type { QueueKeys } from "@panqueue/core";

import type { PanqueueRedisScript } from "./types.js";

/** Non-key arguments for the enqueue script. */
export interface EnqueueArgs {
  jobId: string;
  /** Serialized JobData (JSON string). */
  serialized: string;
}

type EnqueueScriptArguments = [keys: QueueKeys, args: EnqueueArgs];

export type EnqueueScript = PanqueueRedisScript<EnqueueScriptArguments>;

/**
 * Lua script that atomically enqueues a job:
 * 1. Decode the job JSON and write Redis-server lifecycle metadata
 * 2. HSETNX the serialized job data into the jobs hash
 * 3. LPUSH the job ID onto the waiting list
 * 4. PUBLISH a notification on the notify channel
 *
 * Returns the job ID.
 */
export const ENQUEUE_SCRIPT: EnqueueScript = defineScript({
  NUMBER_OF_KEYS: 3,
  SCRIPT: `
local ok, decoded = pcall(cjson.decode, ARGV[2])
if not ok then
  return redis.error_reply('PANQUEUE_INVALID_JOB_JSON: ' .. tostring(decoded))
end
local t = redis.call('TIME')
local now = tonumber(t[1]) * 1000 + math.floor(tonumber(t[2]) / 1000)

decoded['createdAt'] = now
decoded['runs'] = 0
decoded['failures'] = 0
decoded['stalls'] = 0
decoded['maxStalls'] = decoded['maxStalls'] or 5

local serialized = cjson.encode(decoded)

if redis.call('HSETNX', KEYS[1], ARGV[1], serialized) == 0 then
  return redis.error_reply('PANQUEUE_JOB_ID_COLLISION: ' .. ARGV[1])
end
redis.call('LPUSH', KEYS[2], ARGV[1])
redis.call('PUBLISH', KEYS[3], ARGV[1])
return ARGV[1]
`,
  /**
   * KEYS[1..3] = jobs, waiting, notify; ARGV[1..2] = jobId, serialized.
   *
   * @param parser - command parser (injected by node-redis)
   * @param keys   - the queue's key bundle
   * @param args   - {@link EnqueueArgs}
   */
  parseCommand(parser: CommandParser, keys: QueueKeys, args: EnqueueArgs): void {
    parser.pushKeys([keys.jobs, keys.waiting, keys.notify]);
    parser.push(args.jobId, args.serialized);
  },
  transformReply(reply: unknown): unknown {
    return reply;
  },
});
