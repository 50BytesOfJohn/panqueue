import type { JobData, JsonSerializable } from "@panqueue/internal";
import {
  activeKey,
  completedKey,
  failedKey,
  jobsKey,
  notifyKey,
  waitingKey,
} from "@panqueue/internal";
import type { RedisClient } from "../redis_connection.ts";

/** Outcome of a complete() call. */
export type CompleteResult = "completed" | "stale" | "missing";
/** Outcome of a fail() call. */
export type FailResult = "waiting" | "failed" | "stale" | "missing";
/** Outcome of a requeueActive() call (force-shutdown handoff). */
export type RequeueActiveResult = "waiting" | "failed" | "stale" | "missing";

/**
 * Abstract base class for Redis job scheduling operations.
 *
 * Subclasses implement mode-specific `claim()` logic while sharing
 * `complete()`, `fail()`, `extendLock()`, and `recover()` Lua scripts
 * across all modes.
 */
export abstract class BaseJobScheduler<
  T extends JsonSerializable = JsonSerializable,
> {
  protected readonly queueId: string;
  protected readonly client: RedisClient;

  constructor(queueId: string, client: RedisClient) {
    this.queueId = queueId;
    this.client = client;
  }

  /** Claim the next available job. Mode-specific implementation. */
  abstract claim(leaseMs: number): Promise<JobData<T> | null>;

  /** Mark a job as completed; lockToken fences against stalled recovery. */
  async complete(jobId: string, lockToken: string): Promise<CompleteResult> {
    const result = await this.client.complete(
      activeKey(this.queueId),
      completedKey(this.queueId),
      jobsKey(this.queueId),
      jobId,
      String(Date.now()),
      lockToken,
    );

    return result as CompleteResult;
  }

  /** Mark a job as failed. Returns the resulting status. */
  async fail(
    jobId: string,
    error: string,
    lockToken: string,
  ): Promise<FailResult> {
    const result = await this.client.fail(
      activeKey(this.queueId),
      failedKey(this.queueId),
      waitingKey(this.queueId),
      jobsKey(this.queueId),
      notifyKey(this.queueId),
      jobId,
      String(Date.now()),
      error,
      lockToken,
    );

    return result as FailResult;
  }

  /** Extend the lease deadline on an active job. Returns true if extended. */
  async extendLock(
    jobId: string,
    leaseMs: number,
    lockToken: string,
  ): Promise<boolean> {
    const result = await this.client.extendLock(
      activeKey(this.queueId),
      jobsKey(this.queueId),
      jobId,
      String(Date.now() + leaseMs),
      lockToken,
    );
    return result === 1;
  }

  /**
   * Hand an in-flight job back to the queue immediately, fenced by lockToken.
   * Used by force shutdown so a stopping worker does not have to wait for the
   * lease deadline + recovery sweep before the job becomes eligible again.
   */
  async requeueActive(
    jobId: string,
    lockToken: string,
    reason = "shutdown",
  ): Promise<RequeueActiveResult> {
    const result = await this.client.requeueActive(
      activeKey(this.queueId),
      waitingKey(this.queueId),
      jobsKey(this.queueId),
      notifyKey(this.queueId),
      failedKey(this.queueId),
      jobId,
      lockToken,
      reason,
      String(Date.now()),
    );
    return result as RequeueActiveResult;
  }

  /** Recover stalled jobs whose lease has expired. Returns recovered job IDs. */
  async recover(batchSize: number, reason = "stalled"): Promise<string[]> {
    const result = await this.client.recover(
      activeKey(this.queueId),
      waitingKey(this.queueId),
      jobsKey(this.queueId),
      notifyKey(this.queueId),
      failedKey(this.queueId),
      String(Date.now()),
      String(batchSize),
      reason,
    );
    return (result ?? []) as string[];
  }
}
