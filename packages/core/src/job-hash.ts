/**
 * The per-job hash storage contract.
 *
 * Each job lives in its own Redis hash (see {@link jobKey}) with discrete
 * fields. The user payload is stored under `payload` as an opaque JSON string
 * that Lua never decodes — only this module, on the worker side, parses it back
 * into {@link JobData.data}. Every other field is a server-controlled scalar.
 */

import type { JobData, JsonSerializable } from "./types.js";

/** Hash fields stored as numbers (Redis keeps them as strings; coerced here). */
const NUMERIC_JOB_FIELDS = new Set<keyof JobData>([
  "runs",
  "failures",
  "stalls",
  "maxRetries",
  "maxStalls",
  "createdAt",
  "lastStartedAt",
  "lastFailedAt",
  "lastStalledAt",
  "lastRequeuedAt",
  "finishedAt",
  "leaseDeadline",
]);

/**
 * Reconstruct {@link JobData} from the flat `[field, value, field, value, …]`
 * array a Lua `HGETALL` returns through `EVALSHA`.
 *
 * Numeric fields are coerced via `Number`; the opaque `payload` string is
 * `JSON.parse`d into `data`. Throws if the hash is empty/missing required
 * identity fields, or if the payload is not valid JSON.
 */
export function deserializeJobHash<T extends JsonSerializable = JsonSerializable>(
  flat: readonly string[],
): JobData<T> {
  if (flat.length === 0) {
    throw new Error("Cannot deserialize an empty job hash");
  }

  const record: Record<string, unknown> = {};
  let payload: string | undefined;

  for (let i = 0; i < flat.length; i += 2) {
    const field = flat[i];
    const value = flat[i + 1];

    if (field === "payload") {
      payload = value;
      continue;
    }

    record[field] = NUMERIC_JOB_FIELDS.has(field as keyof JobData) ? Number(value) : value;
  }

  if (
    typeof record.id !== "string" ||
    typeof record.queueId !== "string" ||
    typeof record.status !== "string"
  ) {
    throw new Error("Job hash is missing required identity fields (id, queueId, status)");
  }

  if (payload === undefined) {
    throw new Error(`Job ${record.id} hash is missing its payload`);
  }

  record.data = JSON.parse(payload) as T;

  return record as unknown as JobData<T>;
}
