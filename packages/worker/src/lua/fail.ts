import { defineScript, type CommandParser } from "redis";

import type { PanqueueRedisScript } from "./types.js";

type FailScriptArguments = [
  activeKey: string,
  failedKey: string,
  waitingKey: string,
  jobsKey: string,
  notifyKey: string,
  corruptKey: string,
  corruptDataKey: string,
  jobId: string,
  error: string,
  lockToken: string,
];

export type FailScript = PanqueueRedisScript<FailScriptArguments>;

/**
 * Lua script that atomically handles a job failure with retry support:
 * 1. HGET the job hash; if its lockToken does not match the caller's token,
 *    return "stale" without changing state.
 * 2. ZREM the job ID from the active ZSET
 * 3. Increment failures and record handler failure metadata.
 * 4. If failures <= maxRetries: re-queue (LPUSH to waiting, PUBLISH notify)
 * 5. Else: move to failed ZSET scored by finishedAt.
 *
 * Returns "waiting" (retried), "failed" (exhausted), "stale", "missing",
 * or "corrupt".
 */
export const FAIL_SCRIPT: FailScript = defineScript({
  NUMBER_OF_KEYS: 7,
  SCRIPT: `
local raw = redis.call('HGET', KEYS[4], ARGV[1])
if not raw then
  return 'missing'
end

local ok, job = pcall(cjson.decode, raw)
local t = redis.call('TIME')
local now = tonumber(t[1]) * 1000 + math.floor(tonumber(t[2]) / 1000)

if not ok then
  redis.call('ZADD', KEYS[6], now, ARGV[1])
  redis.call('HSET', KEYS[7], ARGV[1], cjson.encode({
    jobId = ARGV[1],
    reason = 'invalid-json',
    detectedAt = now,
    raw = string.sub(raw, 1, 4096)
  }))
  return 'corrupt'
end

if job['lockToken'] ~= ARGV[3] then
  return 'stale'
end

redis.call('ZREM', KEYS[1], ARGV[1])

job['failures'] = (job['failures'] or 0) + 1
job['failureKind'] = 'handler'
job['failedReason'] = ARGV[2]
job['lastError'] = ARGV[2]
job['lastFailedAt'] = now
job['lockToken'] = nil
job['leaseDeadline'] = nil

local maxRetries = job['maxRetries'] or 0

if job['failures'] <= maxRetries then
  job['status'] = 'waiting'
  redis.call('HSET', KEYS[4], ARGV[1], cjson.encode(job))
  redis.call('LPUSH', KEYS[3], ARGV[1])
  redis.call('PUBLISH', KEYS[5], ARGV[1])
  return 'waiting'
else
  job['status'] = 'failed'
  job['finishedAt'] = now
  redis.call('HSET', KEYS[4], ARGV[1], cjson.encode(job))
  redis.call('ZADD', KEYS[2], now, ARGV[1])
  return 'failed'
end
`,
  /**
   * @param parser     - command parser (injected by node-redis)
   * @param activeKey  - active ZSET    (e.g. {q:emails}:active)
   * @param failedKey  - failed ZSET    (e.g. {q:emails}:failed)
   * @param waitingKey - waiting list   (e.g. {q:emails}:waiting)
   * @param jobsKey    - jobs hash      (e.g. {q:emails}:jobs)
   * @param notifyKey  - notify channel (e.g. {q:emails}:notify)
   * @param corruptKey - corrupt ZSET   (e.g. {q:emails}:corrupt)
   * @param corruptDataKey - corrupt data hash
   * @param jobId      - job ID
   * @param error      - error message
   * @param lockToken  - lock token held by the caller
   */
  parseCommand(
    parser: CommandParser,
    activeKey: string,
    failedKey: string,
    waitingKey: string,
    jobsKey: string,
    notifyKey: string,
    corruptKey: string,
    corruptDataKey: string,
    jobId: string,
    error: string,
    lockToken: string,
  ): void {
    parser.pushKeys([
      activeKey,
      failedKey,
      waitingKey,
      jobsKey,
      notifyKey,
      corruptKey,
      corruptDataKey,
    ]);
    parser.push(jobId, error, lockToken);
  },
  transformReply(reply: unknown): unknown {
    return reply;
  },
});
