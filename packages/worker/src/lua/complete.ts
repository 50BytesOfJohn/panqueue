import { defineScript } from "redis";

/**
 * Lua script that atomically marks a job as completed:
 * 1. SREM the job ID from the active set
 * 2. SADD the job ID to the completed set
 * 3. Update the job data with status="completed" and finishedAt
 *
 * Returns 1.
 */
export const COMPLETE_SCRIPT = defineScript({
  NUMBER_OF_KEYS: 3,
  SCRIPT: `
redis.call('SREM', KEYS[1], ARGV[1])
redis.call('SADD', KEYS[2], ARGV[1])

local raw = redis.call('HGET', KEYS[3], ARGV[1])
if raw then
  local job = cjson.decode(raw)
  job['status'] = 'completed'
  job['finishedAt'] = tonumber(ARGV[2])
  redis.call('HSET', KEYS[3], ARGV[1], cjson.encode(job))
end

return 1
`,
  /**
   * @param parser       - command parser (injected by node-redis)
   * @param activeKey    - active set     (e.g. {q:emails}:active)
   * @param completedKey - completed set  (e.g. {q:emails}:completed)
   * @param jobsKey      - jobs hash      (e.g. {q:emails}:jobs)
   * @param jobId        - job ID
   * @param timestamp    - current timestamp (ms)
   */
  parseCommand(parser, activeKey: string, completedKey: string, jobsKey: string, jobId: string, timestamp: string) {
    parser.pushKeys([activeKey, completedKey, jobsKey]);
    parser.push(jobId, timestamp);
  },
  transformReply(reply: unknown) { return reply; },
});
