import {
  type JobData,
  type JsonSerializable,
  type QueueKeys,
  type ResolvedRetention,
  deserializeJobHash,
  queueHashTag,
  queueKeys,
} from "@panqueue/core";

import type { PanqueueWorkerClient } from "../redis-connection.js";

/** Resolved retention policies for both terminal states of a queue. */
export interface QueueRetention {
  completed: ResolvedRetention;
  failed: ResolvedRetention;
}

/** Outcome of a complete() call. */
export type CompleteResult = "completed" | "stale" | "missing";
/** Outcome of a fail() call. */
export type FailResult = "waiting" | "failed" | "stale" | "missing";
/** Outcome of a requeueActive() call (force-shutdown handoff). */
export type RequeueActiveResult = "waiting" | "stale" | "missing";
/** Outcome of an extendLock() call. */
export type ExtendLockResult = "extended" | "stale" | "missing";

/**
 * A job whose pointer survived (in waiting/active) but whose hash is gone.
 * Unrecoverable: core surfaces the jobId once via `onWorkerError`
 * (kind `"corrupt"`) and removes the pointer; durable capture is the
 * developer's via the event.
 */
export interface CorruptJob {
  /** Discriminant: always `true`. */
  corrupt: true;
  /** The orphaned job ID whose hash no longer exists. */
  jobId: string;
}

/** Outcome of a claim call. */
export type ClaimResult<T extends JsonSerializable = JsonSerializable> =
  | JobData<T>
  | CorruptJob
  | null;

/**
 * A stalled job processed by a recovery sweep. Either a recoverable snapshot
 * (requeued or terminally failed) or a {@link CorruptJob} whose hash was gone.
 */
export type RecoveredJob<T extends JsonSerializable = JsonSerializable> =
  | { outcome: "waiting" | "failed"; job: JobData<T> }
  | CorruptJob;

/**
 * Abstract base class for Redis job scheduling operations.
 *
 * Subclasses implement mode-specific `claim()` logic while sharing
 * `complete()`, `fail()`, `extendLock()`, and `recover()` Lua scripts
 * across all modes.
 */
export abstract class BaseJobScheduler<T extends JsonSerializable = JsonSerializable> {
  protected readonly queueId: string;
  protected readonly client: PanqueueWorkerClient;
  protected readonly keys: QueueKeys;
  /** Hash-tag prefix, passed to scripts so they can build per-job keys. */
  protected readonly tag: string;
  protected readonly retention: QueueRetention;

  constructor(queueId: string, client: PanqueueWorkerClient, retention: QueueRetention) {
    this.queueId = queueId;
    this.client = client;
    this.keys = queueKeys(queueId);
    this.tag = queueHashTag(queueId);
    this.retention = retention;
  }

  /**
   * Claim up to `count` available jobs in one round trip. Mode-specific
   * implementation. Returns one entry per claimed job (never a `null`
   * element — the return type excludes it so callers need no null guard);
   * a shorter array than `count` means the queue drained.
   */
  abstract claimBatch(leaseMs: number, count: number): Promise<Exclude<ClaimResult<T>, null>[]>;

  /** Mark a job as completed; lockToken fences against stalled recovery. */
  async complete(jobId: string, lockToken: string): Promise<CompleteResult> {
    const result = await this.client.complete(this.keys, {
      jobId,
      lockToken,
      tag: this.tag,
      retention: this.retention.completed,
    });
    return parseStatus<CompleteResult>("complete", ["completed", "stale", "missing"], result);
  }

  /** Mark a job as failed. Returns the resulting status. */
  async fail(jobId: string, error: string, lockToken: string): Promise<FailResult> {
    const result = await this.client.fail(this.keys, {
      jobId,
      error,
      lockToken,
      tag: this.tag,
      retention: this.retention.failed,
    });
    return parseStatus<FailResult>("fail", ["waiting", "failed", "stale", "missing"], result);
  }

  /** Extend the lease deadline on an active job. Returns true if extended. */
  async extendLock(jobId: string, leaseMs: number, lockToken: string): Promise<ExtendLockResult> {
    const result = await this.client.extendLock(this.keys, {
      jobId,
      lockToken,
      leaseMs,
      tag: this.tag,
    });
    return parseStatus<ExtendLockResult>("extendLock", ["extended", "stale", "missing"], result);
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
    const result = await this.client.requeueActive(this.keys, {
      jobId,
      lockToken,
      reason,
      tag: this.tag,
    });
    return parseStatus<RequeueActiveResult>(
      "requeueActive",
      ["waiting", "stale", "missing"],
      result,
    );
  }

  /**
   * Recover stalled jobs whose lease has expired. Returns one entry per
   * processed job with its outcome and a snapshot of the job hash.
   */
  async recover(batchSize: number, reason = "stalled: lease expired"): Promise<RecoveredJob<T>[]> {
    const result = await this.client.recover(this.keys, {
      batchSize,
      reason,
      tag: this.tag,
      retention: this.retention.failed,
    });
    return parseRecoveredJobs<T>(result);
  }
}

/** Narrow a script's status reply to the outcomes that script can return. */
function parseStatus<T extends string>(op: string, allowed: readonly T[], result: unknown): T {
  const status = allowed.find((value) => value === result);
  if (status === undefined) throw new Error(`Unexpected ${op} result: ${String(result)}`);
  return status;
}

function parseRecoveredJobs<T extends JsonSerializable>(result: unknown): RecoveredJob<T>[] {
  if (result === null || result === undefined) return [];
  if (!Array.isArray(result)) {
    throw new Error(`Unexpected recover result: ${String(result)}`);
  }

  const recovered: RecoveredJob<T>[] = [];
  for (const item of result) {
    if (!Array.isArray(item) || item.length === 0) {
      throw new Error(`Unexpected recover item: ${String(item)}`);
    }
    const [outcome, ...flat] = item as string[];
    // Detect corrupt before deserializeJobHash: the hash is gone, so flat
    // carries only the jobId, not field/value pairs.
    if (outcome === "corrupt") {
      recovered.push({ corrupt: true, jobId: flat[0] });
      continue;
    }
    if (outcome !== "waiting" && outcome !== "failed") {
      throw new Error(`Unexpected recover outcome: ${String(outcome)}`);
    }
    recovered.push({ outcome, job: deserializeJobHash<T>(flat) });
  }
  return recovered;
}
