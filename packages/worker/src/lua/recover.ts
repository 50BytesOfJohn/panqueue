import { defineScript } from "redis";

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
 *    - Treat the crashed claim as a consumed attempt:
 *      - if attempts < maxRetries + 1: LPUSH back to waiting, PUBLISH notify,
 *        clear lockToken/leaseDeadline, mark status="waiting".
 *      - else: SADD failed, mark status="failed" with failedReason=reason.
 * 3. Returns the list of recovered job IDs.
 *
 * Concurrent sweeps by different workers are safe: only the first ZREM wins,
 * the others see no candidate left.
 */
export const RECOVER_SCRIPT = defineScript({
  NUMBER_OF_KEYS: 5,
  SCRIPT: `
local now = tonumber(ARGV[1])
local batch = tonumber(ARGV[2])
local reason = ARGV[3]

local candidates = redis.call('ZRANGEBYSCORE', KEYS[1], 0, now, 'LIMIT', 0, batch)
local recovered = {}

for _, jobId in ipairs(candidates) do
  local score = redis.call('ZSCORE', KEYS[1], jobId)
  if score and tonumber(score) <= now then
    if redis.call('ZREM', KEYS[1], jobId) == 1 then
      local raw = redis.call('HGET', KEYS[3], jobId)
      if raw then
        local job = cjson.decode(raw)
        local maxRetries = job['maxRetries'] or 0
        local attempts = job['attempts'] or 1
        job['failedReason'] = reason
        job['lockToken'] = nil
        job['leaseDeadline'] = nil

        if attempts < maxRetries + 1 then
          job['status'] = 'waiting'
          redis.call('HSET', KEYS[3], jobId, cjson.encode(job))
          redis.call('LPUSH', KEYS[2], jobId)
          redis.call('PUBLISH', KEYS[4], jobId)
        else
          job['status'] = 'failed'
          job['finishedAt'] = now
          redis.call('HSET', KEYS[3], jobId, cjson.encode(job))
          redis.call('SADD', KEYS[5], jobId)
        end
        table.insert(recovered, jobId)
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
   * @param failedKey  - failed set     (e.g. {q:emails}:failed)
   * @param now        - current timestamp (ms)
   * @param batchSize  - max candidates to process per sweep
   * @param reason     - failedReason text written on the job hash
   */
  parseCommand(
    parser,
    activeKey: string,
    waitingKey: string,
    jobsKey: string,
    notifyKey: string,
    failedKey: string,
    now: string,
    batchSize: string,
    reason: string,
  ) {
    parser.pushKeys([activeKey, waitingKey, jobsKey, notifyKey, failedKey]);
    parser.push(now, batchSize, reason);
  },
  transformReply(reply: unknown) {
    return reply;
  },
});
