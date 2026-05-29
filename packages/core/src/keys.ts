/**
 * Redis key generation with hash-tagged prefixes for Cluster compatibility.
 *
 * All keys for a given queue share the hash tag `{q:<queueId>}` so they
 * map to the same hash slot, avoiding CROSSSLOT errors in Lua scripts.
 */

/** Generate a Redis key for the given queue and suffix. */
export function queueKey(queueId: string, suffix: string): string {
  return `{q:${queueId}}:${suffix}`;
}

/** Waiting jobs list — FIFO queue of job IDs. */
export function waitingKey(queueId: string): string {
  return queueKey(queueId, "waiting");
}

/** Active jobs set — currently being processed. */
export function activeKey(queueId: string): string {
  return queueKey(queueId, "active");
}

/** Completed jobs sorted set, scored by finishedAt. */
export function completedKey(queueId: string): string {
  return queueKey(queueId, "completed");
}

/** Failed jobs sorted set, scored by finishedAt. */
export function failedKey(queueId: string): string {
  return queueKey(queueId, "failed");
}

/** Corrupt job index sorted set, scored by detection time. */
export function corruptKey(queueId: string): string {
  return queueKey(queueId, "corrupt");
}

/** Corrupt job forensic payload hash, keyed by job ID. */
export function corruptDataKey(queueId: string): string {
  return queueKey(queueId, "corrupt:data");
}

/** Delayed jobs sorted set — scored by scheduled timestamp. */
export function delayedKey(queueId: string): string {
  return queueKey(queueId, "delayed");
}

/** Job data hash — stores serialized JobData by job ID. */
export function jobsKey(queueId: string): string {
  return queueKey(queueId, "jobs");
}

/** Queue metadata hash (scope, concurrency settings, etc.). */
export function metaKey(queueId: string): string {
  return queueKey(queueId, "meta");
}

/** Pub/sub notification channel for new job availability. */
export function notifyKey(queueId: string): string {
  return queueKey(queueId, "notify");
}
