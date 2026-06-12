import type { ConnectionOptions, QueueMap, RetentionRule } from "@panqueue/core";

export type { RetentionRule } from "@panqueue/core";

/** Per-queue configuration within the shared config. */
export interface QueueConfig {
  /**
   * How long Panqueue keeps finished jobs, per terminal state. `ttl` is the
   * retention window in milliseconds.
   */
  retention?: {
    /** Default: `false` — completed jobs are deleted on success. */
    completed?: RetentionRule;
    /** Default: `{ ttl: 604_800_000 (7 days), count: 1000 }`. */
    failed?: RetentionRule;
  };
}

/** Configuration object returned by `definePanqueueConfig`. */
export interface PanqueueConfig<TQueues extends QueueMap> {
  /** Redis connection configuration shared by client and worker. */
  redis: ConnectionOptions;

  /** Per-queue settings. Keys must match `keyof TQueues`. */
  queues: { [K in keyof TQueues]: QueueConfig };
}
