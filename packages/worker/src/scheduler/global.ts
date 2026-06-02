import {
  activeKey,
  corruptDataKey,
  corruptKey,
  type JobData,
  jobsKey,
  type JsonSerializable,
  waitingKey,
} from "@panqueue/core";

import { BaseJobScheduler, type ClaimResult } from "./base.js";

/**
 * Global mode scheduler — claims jobs via RPOP from the waiting list.
 *
 * Global concurrency is managed by the Worker's semaphore, not by
 * the scheduler itself.
 */
export class GlobalJobScheduler<
  T extends JsonSerializable = JsonSerializable,
> extends BaseJobScheduler<T> {
  /** Claim the next job from the waiting list using an atomic Lua script. */
  async claim(leaseMs: number): Promise<ClaimResult<T>> {
    const result = await this.client.claimGlobal(
      waitingKey(this.queueId),
      activeKey(this.queueId),
      jobsKey(this.queueId),
      corruptKey(this.queueId),
      corruptDataKey(this.queueId),
      String(leaseMs),
    );

    if (!result) return null;
    if (typeof result !== "string") {
      throw new Error(`Unexpected claim result: ${String(result)}`);
    }
    if (result.startsWith("corrupt:")) {
      return {
        status: "corrupt",
        jobId: result.slice("corrupt:".length),
        reason: "invalid-json",
      };
    }
    const parsed: unknown = JSON.parse(result);
    return assertJobData<T>(parsed);
  }
}

function assertJobData<T extends JsonSerializable>(value: unknown): JobData<T> {
  if (!isClaimedJobData<T>(value)) {
    throw new Error("Claimed job payload is missing required active fields");
  }

  return value;
}

function isClaimedJobData<T extends JsonSerializable>(value: unknown): value is JobData<T> {
  return (
    typeof value === "object" &&
    value !== null &&
    "id" in value &&
    typeof value.id === "string" &&
    "queueId" in value &&
    typeof value.queueId === "string" &&
    "status" in value &&
    value.status === "active" &&
    "lockToken" in value &&
    typeof value.lockToken === "string"
  );
}
