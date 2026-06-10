import { defineScript, type CommandParser } from "redis";

import type { QueueKeys, ResolvedRetention } from "@panqueue/core";

import { retentionLua } from "./retention-lua.js";
import type { PanqueueRedisScript } from "./types.js";

/** Non-key arguments for the complete script. */
export interface CompleteArgs {
  jobId: string;
  /** Lock token held by the caller; fences against stalled recovery. */
  lockToken: string;
  /** The queue's hash-tag prefix, used to build the per-job key in Lua. */
  tag: string;
  /** Resolved retention policy for completed jobs. */
  retention: ResolvedRetention;
}

type CompleteScriptArguments = [keys: QueueKeys, args: CompleteArgs];

export type CompleteScript = PanqueueRedisScript<CompleteScriptArguments>;

/**
 * Lua script that atomically marks a job as completed:
 * 1. If the job hash is gone, return "missing"; if its lockToken does not match
 *    the caller's token, return "stale" (the lease was lost to recovery).
 * 2. ZREM the job ID from the active ZSET
 * 3. Apply the completed-retention policy: delete the hash, or keep it
 *    (status="completed", finishedAt, ZADD completed) and trim the index by
 *    ttl/count bounds.
 *
 * Returns "completed", "stale", or "missing".
 */
export const COMPLETE_SCRIPT: CompleteScript = defineScript({
  NUMBER_OF_KEYS: 2,
  SCRIPT: `
local tag = ARGV[3]
local jobKey = tag .. ':job:' .. ARGV[1]
if redis.call('EXISTS', jobKey) == 0 then
  return 'missing'
end

if redis.call('HGET', jobKey, 'lockToken') ~= ARGV[2] then
  return 'stale'
end

local t = redis.call('TIME')
local now = tonumber(t[1]) * 1000 + math.floor(tonumber(t[2]) / 1000)

redis.call('ZREM', KEYS[1], ARGV[1])
redis.call('HDEL', jobKey, 'lockToken', 'leaseDeadline')
${retentionLua({
  status: "completed",
  zsetKey: "KEYS[2]",
  jobIdArg: "ARGV[1]",
  modeArg: "ARGV[4]",
  ttlArg: "ARGV[5]",
  countArg: "ARGV[6]",
})}
return 'completed'
`,
  /**
   * KEYS[1..2] = active, completed;
   * ARGV[1..6] = jobId, lockToken, tag, retention mode, ttl, count.
   *
   * @param parser - command parser (injected by node-redis)
   * @param keys   - the queue's key bundle
   * @param args   - {@link CompleteArgs}
   */
  parseCommand(parser: CommandParser, keys: QueueKeys, args: CompleteArgs): void {
    parser.pushKeys([keys.active, keys.completed]);
    parser.push(
      args.jobId,
      args.lockToken,
      args.tag,
      args.retention.mode,
      String(args.retention.ttl),
      String(args.retention.count),
    );
  },
  transformReply(reply: unknown): unknown {
    return reply;
  },
});
