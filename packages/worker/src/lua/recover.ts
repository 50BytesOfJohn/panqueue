import { defineScript, type CommandParser } from "redis";

import type { QueueKeys, ResolvedRetention } from "@panqueue/core";

import { retentionLua } from "./retention-lua.js";
import type { PanqueueRedisScript } from "./types.js";

/** Non-key arguments for the recover script. */
export interface RecoverArgs {
  /** Max candidates to process per sweep. */
  batchSize: number;
  /** failedReason text written on recovered jobs. */
  reason: string;
  /** The queue's hash-tag prefix, used to build the per-job key in Lua. */
  tag: string;
  /** Resolved retention policy for failed jobs. */
  retention: ResolvedRetention;
}

type RecoverScriptArguments = [keys: QueueKeys, args: RecoverArgs];

export type RecoverScript = PanqueueRedisScript<RecoverScriptArguments>;

/**
 * Lua script that atomically recovers stalled jobs whose lease has expired.
 *
 * Algorithm:
 * 1. ZRANGEBYSCORE active 0 now LIMIT 0 batch — candidate jobIds whose
 *    deadline has passed.
 * 2. For each candidate (under script atomicity, so lock-renewal cannot slip
 *    in between):
 *    - ZSCORE check still <= now (re-fence; renewer may have just moved it).
 *    - ZREM active jobId — winner-takes-all across concurrent sweepers.
 *    - Treat the expired lease as a stall:
 *      - if stalls <= maxStalls: LPUSH back to waiting, PUBLISH notify,
 *        clear lockToken/leaseDeadline, mark status="waiting".
 *      - else: apply the failed-retention policy — delete the hash, or keep
 *        it in the failed ZSET trimmed by ttl/count bounds.
 * 3. Returns the list of recovered job IDs.
 *
 * Concurrent sweeps by different workers are safe: only the first ZREM wins,
 * the others see no candidate left.
 */
export const RECOVER_SCRIPT: RecoverScript = defineScript({
  NUMBER_OF_KEYS: 4,
  SCRIPT: `
local t = redis.call('TIME')
local now = tonumber(t[1]) * 1000 + math.floor(tonumber(t[2]) / 1000)
local batch = tonumber(ARGV[1])
local reason = ARGV[2]
local tag = ARGV[3]

local candidates = redis.call('ZRANGEBYSCORE', KEYS[1], 0, now, 'LIMIT', 0, batch)
local recovered = {}

for _, jobId in ipairs(candidates) do
  local score = redis.call('ZSCORE', KEYS[1], jobId)
  if score and tonumber(score) <= now then
    if redis.call('ZREM', KEYS[1], jobId) == 1 then
      local jobKey = tag .. ':job:' .. jobId
      if redis.call('EXISTS', jobKey) == 1 then
        local stalls = redis.call('HINCRBY', jobKey, 'stalls', 1)
        redis.call('HSET', jobKey,
          'failureKind', 'stalled',
          'failedReason', reason,
          'lastStalledAt', now)
        redis.call('HDEL', jobKey, 'lockToken', 'leaseDeadline')

        local maxStalls = tonumber(redis.call('HGET', jobKey, 'maxStalls')) or 5

        if stalls <= maxStalls then
          redis.call('HSET', jobKey, 'status', 'waiting')
          redis.call('LPUSH', KEYS[2], jobId)
          redis.call('PUBLISH', KEYS[3], jobId)
        else
${retentionLua({
  status: "failed",
  zsetKey: "KEYS[4]",
  jobIdArg: "jobId",
  modeArg: "ARGV[4]",
  ttlArg: "ARGV[5]",
  countArg: "ARGV[6]",
})}
        end
        table.insert(recovered, jobId)
      end
    end
  end
end

return recovered
`,
  /**
   * KEYS[1..4] = active, waiting, notify, failed;
   * ARGV[1..6] = batchSize, reason, tag, retention mode, ttl, count.
   *
   * @param parser - command parser (injected by node-redis)
   * @param keys   - the queue's key bundle
   * @param args   - {@link RecoverArgs}
   */
  parseCommand(parser: CommandParser, keys: QueueKeys, args: RecoverArgs): void {
    parser.pushKeys([keys.active, keys.waiting, keys.notify, keys.failed]);
    parser.push(
      args.batchSize.toString(),
      args.reason,
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
