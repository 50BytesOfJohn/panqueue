import { type JobData, type JsonSerializable, type QueueKeys, queueKeys } from "@panqueue/core";

import type { PanqueueWorkerClient } from "../redis-connection.js";

/** Outcome of a complete() call. */
export type CompleteResult = "completed" | "stale" | "missing" | "corrupt";
/** Outcome of a fail() call. */
export type FailResult = "waiting" | "failed" | "stale" | "missing" | "corrupt";
/** Outcome of a requeueActive() call (force-shutdown handoff). */
export type RequeueActiveResult = "waiting" | "stale" | "missing" | "corrupt";
/** Outcome of an extendLock() call. */
export type ExtendLockResult = "extended" | "stale" | "missing" | "corrupt";
/** Corrupt job result returned when a script quarantines unreadable JSON. */
export interface CorruptJobResult {
  status: "corrupt";
  jobId: string;
  reason: string;
}
/** Outcome of a claim call. */
export type ClaimResult<T extends JsonSerializable = JsonSerializable> =
  | JobData<T>
  | CorruptJobResult
  | null;

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
  /** The queue's Redis key bundle, built once per scheduler. */
  protected readonly keys: QueueKeys;

  constructor(queueId: string, client: PanqueueWorkerClient) {
    this.queueId = queueId;
    this.client = client;
    this.keys = queueKeys(queueId);
  }

  /** Claim the next available job. Mode-specific implementation. */
  abstract claim(leaseMs: number): Promise<ClaimResult<T>>;

  /** Mark a job as completed; lockToken fences against stalled recovery. */
  async complete(jobId: string, lockToken: string): Promise<CompleteResult> {
    const result = await this.client.complete(this.keys, { jobId, lockToken });
    return parseCompleteResult(result);
  }

  /** Mark a job as failed. Returns the resulting status. */
  async fail(jobId: string, error: string, lockToken: string): Promise<FailResult> {
    const result = await this.client.fail(this.keys, { jobId, error, lockToken });
    return parseFailResult(result);
  }

  /** Extend the lease deadline on an active job. Returns true if extended. */
  async extendLock(jobId: string, leaseMs: number, lockToken: string): Promise<ExtendLockResult> {
    const result = await this.client.extendLock(this.keys, { jobId, lockToken, leaseMs });
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
    const result = await this.client.requeueActive(this.keys, { jobId, lockToken, reason });
    return parseRequeueActiveResult(result);
  }

  /** Recover stalled jobs whose lease has expired. Returns recovered job IDs. */
  async recover(batchSize: number, reason = "stalled"): Promise<string[]> {
    const result = await this.client.recover(this.keys, { batchSize, reason });
    return parseStringArray(result);
  }
}

function parseCompleteResult(result: unknown): CompleteResult {
  if (result === "completed" || result === "stale" || result === "missing" || result === "corrupt")
    return result;
  throw new Error(`Unexpected complete result: ${String(result)}`);
}

function parseFailResult(result: unknown): FailResult {
  if (
    result === "waiting" ||
    result === "failed" ||
    result === "stale" ||
    result === "missing" ||
    result === "corrupt"
  )
    return result;
  throw new Error(`Unexpected fail result: ${String(result)}`);
}

function parseExtendLockResult(result: unknown): ExtendLockResult {
  if (result === "extended" || result === "stale" || result === "missing" || result === "corrupt")
    return result;
  throw new Error(`Unexpected extendLock result: ${String(result)}`);
}

function parseRequeueActiveResult(result: unknown): RequeueActiveResult {
  if (result === "waiting" || result === "stale" || result === "missing" || result === "corrupt")
    return result;
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
