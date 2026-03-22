import { defineScript } from "redis";

/**
 * Lua script that atomically handles a job failure with retry support:
 * 1. SREM the job ID from the active set
 * 2. If attempts < maxRetries + 1: re-queue (LPUSH to waiting, PUBLISH notify)
 * 3. Else: move to failed set with finishedAt
 *
 * Returns "waiting" (retried) or "failed" (exhausted).
 */
export const FAIL_SCRIPT = defineScript({
  NUMBER_OF_KEYS: 5,
  SCRIPT: `
redis.call('SREM', KEYS[1], ARGV[1])

local raw = redis.call('HGET', KEYS[4], ARGV[1])
if not raw then
  return 'failed'
end

local job = cjson.decode(raw)
job['failedReason'] = ARGV[3]

local maxRetries = job['maxRetries'] or 0
local attempts = job['attempts'] or 1

if attempts < maxRetries + 1 then
  job['status'] = 'waiting'
  redis.call('HSET', KEYS[4], ARGV[1], cjson.encode(job))
  redis.call('LPUSH', KEYS[3], ARGV[1])
  redis.call('PUBLISH', KEYS[5], ARGV[1])
  return 'waiting'
else
  job['status'] = 'failed'
  job['finishedAt'] = tonumber(ARGV[2])
  redis.call('HSET', KEYS[4], ARGV[1], cjson.encode(job))
  redis.call('SADD', KEYS[2], ARGV[1])
  return 'failed'
end
`,
  /**
   * @param parser     - command parser (injected by node-redis)
   * @param activeKey  - active set     (e.g. {q:emails}:active)
   * @param failedKey  - failed set     (e.g. {q:emails}:failed)
   * @param waitingKey - waiting list   (e.g. {q:emails}:waiting)
   * @param jobsKey    - jobs hash      (e.g. {q:emails}:jobs)
   * @param notifyKey  - notify channel (e.g. {q:emails}:notify)
   * @param jobId      - job ID
   * @param timestamp  - current timestamp (ms)
   * @param error      - error message
   */
  parseCommand(
    parser,
    activeKey: string,
    failedKey: string,
    waitingKey: string,
    jobsKey: string,
    notifyKey: string,
    jobId: string,
    timestamp: string,
    error: string,
  ) {
    parser.pushKeys([activeKey, failedKey, waitingKey, jobsKey, notifyKey]);
    parser.push(jobId, timestamp, error);
  },
  transformReply(reply: unknown) { return reply; },
});
