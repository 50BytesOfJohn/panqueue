/**
 * Redis key generation with hash-tagged prefixes for Cluster compatibility.
 *
 * All keys for a given queue share the hash tag `{q:<queueId>}` so they
 * map to the same hash slot, avoiding CROSSSLOT errors in Lua scripts.
 *
 * Keys are branded with their logical role ({@link QueueKey}) so a key of one
 * role cannot be passed where another is expected, and so the only sanctioned
 * place a key string is constructed is here.
 */

declare const keyBrand: unique symbol;

/**
 * A Redis key string tagged with its logical role. Structurally a `string`
 * (and assignable to `RedisArgument`), but distinct from plain strings and
 * from keys of other roles, so the wrong key can't be passed positionally.
 */
export type QueueKey<Role extends string> = string & { readonly [keyBrand]: Role };

/** Generate a Redis key for the given queue and suffix. */
export function queueKey(queueId: string, suffix: string): string {
  return `{q:${queueId}}:${suffix}`;
}

/** Waiting jobs list — FIFO queue of job IDs. */
export function waitingKey(queueId: string): QueueKey<"waiting"> {
  return queueKey(queueId, "waiting") as QueueKey<"waiting">;
}

/** Active jobs set — currently being processed. */
export function activeKey(queueId: string): QueueKey<"active"> {
  return queueKey(queueId, "active") as QueueKey<"active">;
}

/** Completed jobs sorted set, scored by finishedAt. */
export function completedKey(queueId: string): QueueKey<"completed"> {
  return queueKey(queueId, "completed") as QueueKey<"completed">;
}

/** Failed jobs sorted set, scored by finishedAt. */
export function failedKey(queueId: string): QueueKey<"failed"> {
  return queueKey(queueId, "failed") as QueueKey<"failed">;
}

/** Corrupt job index sorted set, scored by detection time. */
export function corruptKey(queueId: string): QueueKey<"corrupt"> {
  return queueKey(queueId, "corrupt") as QueueKey<"corrupt">;
}

/** Corrupt job forensic payload hash, keyed by job ID. */
export function corruptDataKey(queueId: string): QueueKey<"corrupt:data"> {
  return queueKey(queueId, "corrupt:data") as QueueKey<"corrupt:data">;
}

/** Delayed jobs sorted set — scored by scheduled timestamp. */
export function delayedKey(queueId: string): QueueKey<"delayed"> {
  return queueKey(queueId, "delayed") as QueueKey<"delayed">;
}

/** Job data hash — stores serialized JobData by job ID. */
export function jobsKey(queueId: string): QueueKey<"jobs"> {
  return queueKey(queueId, "jobs") as QueueKey<"jobs">;
}

/** Queue metadata hash (scope, concurrency settings, etc.). */
export function metaKey(queueId: string): QueueKey<"meta"> {
  return queueKey(queueId, "meta") as QueueKey<"meta">;
}

/** Pub/sub notification channel for new job availability. */
export function notifyKey(queueId: string): QueueKey<"notify"> {
  return queueKey(queueId, "notify") as QueueKey<"notify">;
}

/**
 * The full set of Redis keys for a single queue, all sharing one hash slot.
 *
 * Passed as a single bundle to every Lua script command so call sites carry
 * named keys (not a positional list) and each script's `parseCommand` selects
 * the subset it needs in one place, adjacent to the script body.
 */
export interface QueueKeys {
  readonly waiting: QueueKey<"waiting">;
  readonly active: QueueKey<"active">;
  readonly completed: QueueKey<"completed">;
  readonly failed: QueueKey<"failed">;
  readonly delayed: QueueKey<"delayed">;
  readonly corrupt: QueueKey<"corrupt">;
  readonly corruptData: QueueKey<"corrupt:data">;
  readonly jobs: QueueKey<"jobs">;
  readonly meta: QueueKey<"meta">;
  readonly notify: QueueKey<"notify">;
}

/** Build the full {@link QueueKeys} bundle for a queue. */
export function queueKeys(queueId: string): QueueKeys {
  return {
    waiting: waitingKey(queueId),
    active: activeKey(queueId),
    completed: completedKey(queueId),
    failed: failedKey(queueId),
    delayed: delayedKey(queueId),
    corrupt: corruptKey(queueId),
    corruptData: corruptDataKey(queueId),
    jobs: jobsKey(queueId),
    meta: metaKey(queueId),
    notify: notifyKey(queueId),
  };
}
