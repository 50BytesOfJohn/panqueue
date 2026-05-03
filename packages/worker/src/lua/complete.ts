import { defineScript } from "redis";

/**
 * Lua script that atomically marks a job as completed:
 * 1. HGET the job hash; if its lockToken does not match the caller's token,
 *    return "stale" without changing state (the lease was lost to recovery).
 * 2. ZREM the job ID from the active ZSET
 * 3. SADD the job ID to the completed set
 * 4. Update the job data with status="completed", finishedAt, and clear lock fields
 *
 * Returns "completed", "stale", or "missing".
 */
export const COMPLETE_SCRIPT = defineScript({
  NUMBER_OF_KEYS: 3,
  SCRIPT: `
local raw = redis.call('HGET', KEYS[3], ARGV[1])
if not raw then
  return 'missing'
end

local job = cjson.decode(raw)
if job['lockToken'] ~= ARGV[3] then
  return 'stale'
end

redis.call('ZREM', KEYS[1], ARGV[1])
redis.call('SADD', KEYS[2], ARGV[1])

job['status'] = 'completed'
job['finishedAt'] = tonumber(ARGV[2])
job['lockToken'] = nil
job['leaseDeadline'] = nil
redis.call('HSET', KEYS[3], ARGV[1], cjson.encode(job))

return 'completed'
`,
  /**
   * @param parser       - command parser (injected by node-redis)
   * @param activeKey    - active ZSET    (e.g. {q:emails}:active)
   * @param completedKey - completed set  (e.g. {q:emails}:completed)
   * @param jobsKey      - jobs hash      (e.g. {q:emails}:jobs)
   * @param jobId        - job ID
   * @param timestamp    - current timestamp (ms)
   * @param lockToken    - the lock token held by the caller
   */
  parseCommand(
    parser,
    activeKey: string,
    completedKey: string,
    jobsKey: string,
    jobId: string,
    timestamp: string,
    lockToken: string,
  ) {
    parser.pushKeys([activeKey, completedKey, jobsKey]);
    parser.push(jobId, timestamp, lockToken);
  },
  transformReply(reply: unknown) {
    return reply;
  },
});
