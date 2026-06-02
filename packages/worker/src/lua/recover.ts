import { defineScript, type CommandParser } from "redis";

import type { PanqueueRedisScript } from "./types.js";

type RecoverScriptArguments = [
  activeKey: string,
  waitingKey: string,
  jobsKey: string,
  notifyKey: string,
  failedKey: string,
  corruptKey: string,
  corruptDataKey: string,
  batchSize: string,
  reason: string,
];

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
 *      - else: ZADD failed, mark status="failed" with failedReason=reason.
 * 3. Returns the list of recovered job IDs.
 *
 * Concurrent sweeps by different workers are safe: only the first ZREM wins,
 * the others see no candidate left.
 */
export const RECOVER_SCRIPT: RecoverScript = defineScript({
  NUMBER_OF_KEYS: 7,
  SCRIPT: `
local t = redis.call('TIME')
local now = tonumber(t[1]) * 1000 + math.floor(tonumber(t[2]) / 1000)
local batch = tonumber(ARGV[1])
local reason = ARGV[2]

local candidates = redis.call('ZRANGEBYSCORE', KEYS[1], 0, now, 'LIMIT', 0, batch)
local recovered = {}

for _, jobId in ipairs(candidates) do
  local score = redis.call('ZSCORE', KEYS[1], jobId)
  if score and tonumber(score) <= now then
    if redis.call('ZREM', KEYS[1], jobId) == 1 then
      local raw = redis.call('HGET', KEYS[3], jobId)
      if raw then
        local ok, job = pcall(cjson.decode, raw)
        if not ok then
          redis.call('ZADD', KEYS[6], now, jobId)
          redis.call('HSET', KEYS[7], jobId, cjson.encode({
            jobId = jobId,
            reason = 'invalid-json',
            detectedAt = now,
            raw = string.sub(raw, 1, 4096)
          }))
          table.insert(recovered, 'corrupt:' .. jobId)
        else
        local maxStalls = job['maxStalls'] or 5
        job['stalls'] = (job['stalls'] or 0) + 1
        job['failureKind'] = 'stalled'
        job['failedReason'] = reason
        job['lastStalledAt'] = now
        job['lockToken'] = nil
        job['leaseDeadline'] = nil

        if job['stalls'] <= maxStalls then
          job['status'] = 'waiting'
          redis.call('HSET', KEYS[3], jobId, cjson.encode(job))
          redis.call('LPUSH', KEYS[2], jobId)
          redis.call('PUBLISH', KEYS[4], jobId)
        else
          job['status'] = 'failed'
          job['finishedAt'] = now
          redis.call('HSET', KEYS[3], jobId, cjson.encode(job))
          redis.call('ZADD', KEYS[5], now, jobId)
        end
        table.insert(recovered, jobId)
        end
      end
    end
  end
end

return recovered
`,
  /**
   * @param parser     - command parser (injected by node-redis)
   * @param activeKey  - active ZSET    (e.g. {q:emails}:active)
   * @param waitingKey - waiting list   (e.g. {q:emails}:waiting)
   * @param jobsKey    - jobs hash      (e.g. {q:emails}:jobs)
   * @param notifyKey  - notify channel (e.g. {q:emails}:notify)
   * @param failedKey  - failed ZSET    (e.g. {q:emails}:failed)
   * @param corruptKey - corrupt ZSET   (e.g. {q:emails}:corrupt)
   * @param corruptDataKey - corrupt data hash
   * @param batchSize  - max candidates to process per sweep
   * @param reason     - failedReason text written on the job hash
   */
  parseCommand(
    parser: CommandParser,
    activeKey: string,
    waitingKey: string,
    jobsKey: string,
    notifyKey: string,
    failedKey: string,
    corruptKey: string,
    corruptDataKey: string,
    batchSize: string,
    reason: string,
  ): void {
    parser.pushKeys([
      activeKey,
      waitingKey,
      jobsKey,
      notifyKey,
      failedKey,
      corruptKey,
      corruptDataKey,
    ]);
    parser.push(batchSize, reason);
  },
  transformReply(reply: unknown): unknown {
    return reply;
  },
});
