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

/**
 * Abstract base class for Redis job scheduling operations.
 *
 * Subclasses implement mode-specific `claim()` logic while sharing
 * `complete()` and `fail()` Lua scripts across all modes.
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
  abstract claim(): Promise<JobData<T> | null>;

  /** Mark a job as completed. */
  async complete(jobId: string): Promise<void> {
    await this.client.complete(
      activeKey(this.queueId),
      completedKey(this.queueId),
      jobsKey(this.queueId),
      jobId,
      String(Date.now()),
    );
  }

  /** Mark a job as failed. Returns the resulting status ("waiting" or "failed"). */
  async fail(jobId: string, error: string): Promise<string> {
    const result = await this.client.fail(
      activeKey(this.queueId),
      failedKey(this.queueId),
      waitingKey(this.queueId),
      jobsKey(this.queueId),
      notifyKey(this.queueId),
      jobId,
      String(Date.now()),
      error,
    );

    return result as string;
  }
}
