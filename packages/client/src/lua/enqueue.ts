/**
 * Lua script that atomically enqueues a job:
 * 1. HSET the serialized job data into the jobs hash
 * 2. LPUSH the job ID onto the waiting list
 * 3. PUBLISH a notification on the notify channel
 *
 * KEYS[1] = jobs hash key      (e.g. {q:emails}:jobs)
 * KEYS[2] = waiting list key   (e.g. {q:emails}:waiting)
 * KEYS[3] = notify channel key (e.g. {q:emails}:notify)
 *
 * ARGV[1] = job ID
 * ARGV[2] = serialized job data (JSON string)
 *
 * Returns the job ID.
 */
export const ENQUEUE_SCRIPT = `
redis.call('HSET', KEYS[1], ARGV[1], ARGV[2])
redis.call('LPUSH', KEYS[2], ARGV[1])
redis.call('PUBLISH', KEYS[3], ARGV[1])
return ARGV[1]
`;
