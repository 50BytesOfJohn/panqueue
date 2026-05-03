import { defineScript } from "redis";

/**
 * Lua script that atomically claims a job from the waiting list (global mode):
 * 1. RPOP a job ID from the waiting list
 * 2. HGET the job data and validate it exists
 * 3. ZADD the job ID into the active ZSET scored by lease deadline (now + leaseMs)
 * 4. Generate a fresh lockToken and set status/processedAt/attempts/lockToken on the hash
 * 5. Return the updated job JSON
 *
 * Returns the updated job JSON string, or nil if the waiting list is empty.
 * Returns redis.error_reply if the job hash is missing (partial state).
 */
export const CLAIM_GLOBAL_SCRIPT = defineScript({
  NUMBER_OF_KEYS: 3,
  SCRIPT: `
local jobId = redis.call('RPOP', KEYS[1])
if not jobId then
  return nil
end

local raw = redis.call('HGET', KEYS[3], jobId)
if not raw then
  return redis.error_reply('PANQUEUE_MISSING_JOB_DATA: ' .. jobId)
end

local now = tonumber(ARGV[1])
local leaseMs = tonumber(ARGV[2])
local deadline = now + leaseMs

local job = cjson.decode(raw)
job['status'] = 'active'
job['processedAt'] = now
job['attempts'] = (job['attempts'] or 0) + 1

local token = redis.sha1hex(jobId .. ':' .. tostring(now) .. ':' .. tostring(job['attempts']))
job['lockToken'] = token
job['leaseDeadline'] = deadline

redis.call('ZADD', KEYS[2], deadline, jobId)
local updated = cjson.encode(job)
redis.call('HSET', KEYS[3], jobId, updated)

return updated
`,
  /**
   * @param parser     - command parser (injected by node-redis)
   * @param waitingKey - waiting list   (e.g. {q:emails}:waiting)
   * @param activeKey  - active ZSET    (e.g. {q:emails}:active)
   * @param jobsKey    - jobs hash      (e.g. {q:emails}:jobs)
   * @param timestamp  - current timestamp (ms)
   * @param leaseMs    - lease duration in ms
   */
  parseCommand(
    parser,
    waitingKey: string,
    activeKey: string,
    jobsKey: string,
    timestamp: string,
    leaseMs: string,
  ) {
    parser.pushKeys([waitingKey, activeKey, jobsKey]);
    parser.push(timestamp, leaseMs);
  },
  transformReply(reply: unknown) {
    return reply;
  },
});
