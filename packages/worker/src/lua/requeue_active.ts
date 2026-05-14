import { defineScript } from "redis";

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
export const REQUEUE_ACTIVE_SCRIPT = defineScript({
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
   * @param parser     - command parser (injected by node-redis)
   * @param activeKey  - active ZSET    (e.g. {q:emails}:active)
   * @param waitingKey - waiting list   (e.g. {q:emails}:waiting)
   * @param jobsKey    - jobs hash      (e.g. {q:emails}:jobs)
   * @param notifyKey  - notify channel (e.g. {q:emails}:notify)
   * @param corruptKey - corrupt ZSET   (e.g. {q:emails}:corrupt)
   * @param corruptDataKey - corrupt data hash
   * @param jobId      - job ID
   * @param lockToken  - lock token held by the caller
   * @param reason     - failedReason text written on the job hash
   */
  parseCommand(
    parser,
    activeKey: string,
    waitingKey: string,
    jobsKey: string,
    notifyKey: string,
    corruptKey: string,
    corruptDataKey: string,
    jobId: string,
    lockToken: string,
    reason: string,
  ) {
    parser.pushKeys([
      activeKey,
      waitingKey,
      jobsKey,
      notifyKey,
      corruptKey,
      corruptDataKey,
    ]);
    parser.push(jobId, lockToken, reason);
  },
  transformReply(reply: unknown) {
    return reply;
  },
});
