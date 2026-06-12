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

/** The hash-tag prefix shared by every key of a queue (e.g. `{q:emails}`). */
export function queueHashTag(queueId: string): string {
  return `{q:${queueId}}`;
}

/** Generate a Redis key for the given queue and suffix. */
export function queueKey(queueId: string, suffix: string): string {
  return `${queueHashTag(queueId)}:${suffix}`;
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

/** Delayed jobs sorted set — scored by scheduled timestamp. */
export function delayedKey(queueId: string): QueueKey<"delayed"> {
  return queueKey(queueId, "delayed") as QueueKey<"delayed">;
}

/** Per-job hash — one hash per job, storing the opaque payload plus discrete
 *  lifecycle fields. Shares the queue's hash tag so it lives in the same slot. */
export function jobKey(queueId: string, jobId: string): QueueKey<"job"> {
  return queueKey(queueId, `job:${jobId}`) as QueueKey<"job">;
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
    notify: notifyKey(queueId),
  };
}
