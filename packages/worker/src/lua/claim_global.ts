import { defineScript } from "redis";

/**
 * Lua script that atomically claims a job from the waiting list (global mode):
 * 1. RPOP a job ID from the waiting list
 * 2. HGET the job data and validate it exists
 * 3. SADD the job ID to the active set
 * 4. Update status/processedAt/attempts, HSET back
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

redis.call('SADD', KEYS[2], jobId)

local job = cjson.decode(raw)
job['status'] = 'active'
job['processedAt'] = tonumber(ARGV[1])
job['attempts'] = (job['attempts'] or 0) + 1

local updated = cjson.encode(job)
redis.call('HSET', KEYS[3], jobId, updated)

return updated
`,
  /**
   * @param parser     - command parser (injected by node-redis)
   * @param waitingKey - waiting list   (e.g. {q:emails}:waiting)
   * @param activeKey  - active set     (e.g. {q:emails}:active)
   * @param jobsKey    - jobs hash      (e.g. {q:emails}:jobs)
   * @param timestamp  - current timestamp (ms)
   */
  parseCommand(parser, waitingKey: string, activeKey: string, jobsKey: string, timestamp: string) {
    parser.pushKeys([waitingKey, activeKey, jobsKey]);
    parser.push(timestamp);
  },
  transformReply(reply: unknown) { return reply; },
});
