import { defineScript } from "redis";

/**
 * Lua script that atomically enqueues a job:
 * 1. HSET the serialized job data into the jobs hash
 * 2. LPUSH the job ID onto the waiting list
 * 3. PUBLISH a notification on the notify channel
 *
 * Returns the job ID.
 */
export const ENQUEUE_SCRIPT = defineScript({
  NUMBER_OF_KEYS: 3,
  SCRIPT: `
redis.call('HSET', KEYS[1], ARGV[1], ARGV[2])
redis.call('LPUSH', KEYS[2], ARGV[1])
redis.call('PUBLISH', KEYS[3], ARGV[1])
return ARGV[1]
`,
  /**
   * @param parser  - command parser (injected by node-redis)
   * @param jobsKey - jobs hash key      (e.g. {q:emails}:jobs)
   * @param waitingKey - waiting list key (e.g. {q:emails}:waiting)
   * @param notifyKey - notify channel    (e.g. {q:emails}:notify)
   * @param jobId   - job ID
   * @param serialized - serialized job data (JSON string)
   */
  parseCommand(parser, jobsKey: string, waitingKey: string, notifyKey: string, jobId: string, serialized: string) {
    parser.pushKeys([jobsKey, waitingKey, notifyKey]);
    parser.push(jobId, serialized);
  },
  transformReply(reply: unknown) { return reply; },
});
