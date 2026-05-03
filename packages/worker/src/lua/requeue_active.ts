import { defineScript } from "redis";

/**
 * Lua script used by force shutdown to atomically hand an in-flight job
 * back to the queue without waiting for its lease to expire.
 *
 * Mirrors the recover script's retry/fail decision so a force-shutdown is
 * indistinguishable from a stall, with one exception: it is invoked
 * directly by the worker that owns the lease and is fenced on lockToken
 * rather than on lease deadline.
 *
 * 1. HGET the job hash; if missing, return "missing".
 * 2. If the stored lockToken does not match the caller's, return "stale"
 *    (recovery already grabbed it — nothing to requeue).
 * 3. ZREM the job from the active ZSET. Clear lockToken/leaseDeadline.
 * 4. Treat the killed claim as a consumed attempt:
 *    - if attempts < maxRetries + 1: LPUSH to waiting, PUBLISH notify.
 *    - else: SADD failed with finishedAt and the supplied reason.
 *
 * Returns "waiting", "failed", "stale", or "missing".
 */
export const REQUEUE_ACTIVE_SCRIPT = defineScript({
  NUMBER_OF_KEYS: 5,
  SCRIPT: `
local raw = redis.call('HGET', KEYS[3], ARGV[1])
if not raw then
  return 'missing'
end

local job = cjson.decode(raw)
if job['lockToken'] ~= ARGV[2] then
  return 'stale'
end

redis.call('ZREM', KEYS[1], ARGV[1])

job['lockToken'] = nil
job['leaseDeadline'] = nil
job['failedReason'] = ARGV[3]

local maxRetries = job['maxRetries'] or 0
local attempts = job['attempts'] or 1

if attempts < maxRetries + 1 then
  job['status'] = 'waiting'
  redis.call('HSET', KEYS[3], ARGV[1], cjson.encode(job))
  redis.call('LPUSH', KEYS[2], ARGV[1])
  redis.call('PUBLISH', KEYS[4], ARGV[1])
  return 'waiting'
else
  job['status'] = 'failed'
  job['finishedAt'] = tonumber(ARGV[4])
  redis.call('HSET', KEYS[3], ARGV[1], cjson.encode(job))
  redis.call('SADD', KEYS[5], ARGV[1])
  return 'failed'
end
`,
  /**
   * @param parser     - command parser (injected by node-redis)
   * @param activeKey  - active ZSET    (e.g. {q:emails}:active)
   * @param waitingKey - waiting list   (e.g. {q:emails}:waiting)
   * @param jobsKey    - jobs hash      (e.g. {q:emails}:jobs)
   * @param notifyKey  - notify channel (e.g. {q:emails}:notify)
   * @param failedKey  - failed set     (e.g. {q:emails}:failed)
   * @param jobId      - job ID
   * @param lockToken  - lock token held by the caller
   * @param reason     - failedReason text written on the job hash
   * @param now        - current timestamp (ms), used as finishedAt on terminal failure
   */
  parseCommand(
    parser,
    activeKey: string,
    waitingKey: string,
    jobsKey: string,
    notifyKey: string,
    failedKey: string,
    jobId: string,
    lockToken: string,
    reason: string,
    now: string,
  ) {
    parser.pushKeys([activeKey, waitingKey, jobsKey, notifyKey, failedKey]);
    parser.push(jobId, lockToken, reason, now);
  },
  transformReply(reply: unknown) {
    return reply;
  },
});
