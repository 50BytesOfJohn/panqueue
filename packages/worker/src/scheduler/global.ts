import type { JobData, JsonSerializable } from "@panqueue/internal";
import { activeKey, jobsKey, waitingKey } from "@panqueue/internal";
import type { RedisClient } from "../redis_connection.ts";
import { BaseJobScheduler } from "./base.ts";

/**
 * Global mode scheduler — claims jobs via RPOP from the waiting list.
 *
 * Global concurrency is managed by the Worker's semaphore, not by
 * the scheduler itself.
 */
export class GlobalJobScheduler<
  T extends JsonSerializable = JsonSerializable,
> extends BaseJobScheduler<T> {
  constructor(queueId: string, client: RedisClient) {
    super(queueId, client);
  }

  /** Claim the next job from the waiting list using an atomic Lua script. */
  async claim(): Promise<JobData<T> | null> {
    const result = await this.client.claimGlobal(
      waitingKey(this.queueId),
      activeKey(this.queueId),
      jobsKey(this.queueId),
      String(Date.now()),
    );

    if (!result) return null;
    return JSON.parse(result as string) as JobData<T>;
  }
}
