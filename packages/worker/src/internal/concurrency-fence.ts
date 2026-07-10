import { queueKeys } from "@panqueue/core";

import type { QueueConcurrencyLimit } from "../define-worker.js";
import { ConcurrencyLimitConflictError } from "../errors.js";
import type { PanqueueWorkerClient } from "../redis-connection.js";

/**
 * Declare a queue's global concurrency limit in Redis under the versioned
 * fencing rule. Resolves on written/ignored/unchanged; throws
 * ConcurrencyLimitConflictError on a same-version/different-limit conflict.
 */
export async function declareConcurrencyLimit(
  client: PanqueueWorkerClient,
  queueId: string,
  declared: QueueConcurrencyLimit,
): Promise<void> {
  const result = await client.declareConcurrencyLimit(queueKeys(queueId), {
    limit: declared.limit,
    version: declared.version,
  });
  const [status, storedLimit] = parseDeclareResult(result);
  if (status === "conflict") {
    throw new ConcurrencyLimitConflictError(queueId, declared.version, storedLimit, declared.limit);
  }
}

function parseDeclareResult(result: unknown): [string, number] {
  if (Array.isArray(result) && typeof result[0] === "string") {
    const status = result[0];
    if (
      status === "written" ||
      status === "ignored" ||
      status === "unchanged" ||
      status === "conflict"
    ) {
      return [status, Number(result[1])];
    }
  }
  throw new Error(`Unexpected declareConcurrencyLimit result: ${String(result)}`);
}
