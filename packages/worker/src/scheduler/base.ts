import {
  type JobData,
  type JsonSerializable,
  type QueueKeys,
  type ResolvedRetention,
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
/** Outcome of a claim call. */
export type ClaimResult<T extends JsonSerializable = JsonSerializable> = JobData<T> | null;

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

  /** Claim the next available job. Mode-specific implementation. */
  abstract claim(leaseMs: number): Promise<ClaimResult<T>>;

  /** Mark a job as completed; lockToken fences against stalled recovery. */
  async complete(jobId: string, lockToken: string): Promise<CompleteResult> {
    const result = await this.client.complete(this.keys, {
      jobId,
      lockToken,
      tag: this.tag,
      retention: this.retention.completed,
    });
    return parseCompleteResult(result);
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
    return parseFailResult(result);
  }

  /** Extend the lease deadline on an active job. Returns true if extended. */
  async extendLock(jobId: string, leaseMs: number, lockToken: string): Promise<ExtendLockResult> {
    const result = await this.client.extendLock(this.keys, {
      jobId,
      lockToken,
      leaseMs,
      tag: this.tag,
    });
    return parseExtendLockResult(result);
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
    return parseRequeueActiveResult(result);
  }

  /** Recover stalled jobs whose lease has expired. Returns recovered job IDs. */
  async recover(batchSize: number, reason = "stalled"): Promise<string[]> {
    const result = await this.client.recover(this.keys, {
      batchSize,
      reason,
      tag: this.tag,
      retention: this.retention.failed,
    });
    return parseStringArray(result);
  }
}

function parseCompleteResult(result: unknown): CompleteResult {
  if (result === "completed" || result === "stale" || result === "missing") return result;
  throw new Error(`Unexpected complete result: ${String(result)}`);
}

function parseFailResult(result: unknown): FailResult {
  if (result === "waiting" || result === "failed" || result === "stale" || result === "missing")
    return result;
  throw new Error(`Unexpected fail result: ${String(result)}`);
}

function parseExtendLockResult(result: unknown): ExtendLockResult {
  if (result === "extended" || result === "stale" || result === "missing") return result;
  throw new Error(`Unexpected extendLock result: ${String(result)}`);
}

function parseRequeueActiveResult(result: unknown): RequeueActiveResult {
  if (result === "waiting" || result === "stale" || result === "missing") return result;
  throw new Error(`Unexpected requeueActive result: ${String(result)}`);
}

function parseStringArray(result: unknown): string[] {
  if (result === null || result === undefined) return [];
  if (!Array.isArray(result)) {
    throw new Error(`Unexpected recover result: ${String(result)}`);
  }

  const values: string[] = [];
  for (const item of result) {
    if (typeof item !== "string") {
      throw new Error(`Unexpected recover item: ${String(item)}`);
    }
    values.push(item);
  }
  return values;
}
