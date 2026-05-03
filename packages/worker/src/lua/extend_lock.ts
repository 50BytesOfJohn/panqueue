import { defineScript } from "redis";

/**
 * Lua script that atomically extends the lease deadline on an active job.
 *
 * 1. HGET the job hash; if its lockToken does not match the caller's token,
 *    return 0 — the lease was lost (e.g., recovery already requeued it).
 * 2. ZADD XX active newDeadline jobId — only updates if the job is still in
 *    the active ZSET. If recovery removed it, XX makes the ZADD a no-op and
 *    we return 0.
 * 3. Update leaseDeadline on the hash and return 1.
 *
 * Returns 1 if extended, 0 if the lease was lost.
 */
export const EXTEND_LOCK_SCRIPT = defineScript({
  NUMBER_OF_KEYS: 2,
  SCRIPT: `
local raw = redis.call('HGET', KEYS[2], ARGV[1])
if not raw then
  return 0
end

local job = cjson.decode(raw)
if job['lockToken'] ~= ARGV[3] then
  return 0
end

local newDeadline = tonumber(ARGV[2])
local added = redis.call('ZADD', KEYS[1], 'XX', 'CH', newDeadline, ARGV[1])
-- 'CH' returns 1 if score changed; 0 if not present or unchanged. A "not
-- present" outcome is what we care about: ensure ZSCORE confirms presence.
local score = redis.call('ZSCORE', KEYS[1], ARGV[1])
if not score then
  return 0
end

job['leaseDeadline'] = newDeadline
redis.call('HSET', KEYS[2], ARGV[1], cjson.encode(job))
return 1
`,
  /**
   * @param parser      - command parser (injected by node-redis)
   * @param activeKey   - active ZSET    (e.g. {q:emails}:active)
   * @param jobsKey     - jobs hash      (e.g. {q:emails}:jobs)
   * @param jobId       - job ID
   * @param newDeadline - new lease deadline (ms)
   * @param lockToken   - lock token held by the caller
   */
  parseCommand(
    parser,
    activeKey: string,
    jobsKey: string,
    jobId: string,
    newDeadline: string,
    lockToken: string,
  ) {
    parser.pushKeys([activeKey, jobsKey]);
    parser.push(jobId, newDeadline, lockToken);
  },
  transformReply(reply: unknown) {
    return reply;
  },
});
