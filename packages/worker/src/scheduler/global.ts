import { deserializeJobHash, type JsonSerializable } from "@panqueue/core";

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
    const result = await this.client.claimGlobal(this.keys, { leaseMs, tag: this.tag });

    if (!result) return null;
    if (!Array.isArray(result)) {
      throw new Error(`Unexpected claim result: ${String(result)}`);
    }
    return deserializeJobHash<T>(result as string[]);
  }
}
