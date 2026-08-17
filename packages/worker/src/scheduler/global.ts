import { deserializeJobHash, type JsonSerializable } from "@panqueue/core";

import { BaseJobScheduler, type ClaimResult } from "./base.js";

/**
 * Decode one raw claim entry into a job or a corrupt marker. Never throws:
 * a non-array reply or a `deserializeJobHash` failure becomes a corrupt result
 * with a best-effort jobId, so one bad entry can never abort a whole batch.
 */
function decodeClaimEntry<T extends JsonSerializable>(
  entry: unknown,
): Exclude<ClaimResult<T>, null> {
  if (!Array.isArray(entry)) {
    return { corrupt: true, jobId: "unknown" };
  }
  // Detect corrupt before deserializeJobHash: the hash is gone, so the
  // entry is ['corrupt', jobId], not field/value pairs.
  if (entry[0] === "corrupt") return { corrupt: true, jobId: entry[1] as string };
  try {
    return deserializeJobHash<T>(entry as string[]);
  } catch {
    return { corrupt: true, jobId: jobIdFromFlat(entry) };
  }
}

/** Best-effort scan of a flat `[field, value, …]` hash for the `id` field. */
function jobIdFromFlat(flat: unknown[]): string {
  for (let i = 0; i + 1 < flat.length; i += 2) {
    if (flat[i] === "id" && typeof flat[i + 1] === "string") return flat[i + 1] as string;
  }
  return "unknown";
}

/**
 * Global mode scheduler — claims jobs via RPOP from the waiting list.
 *
 * Global concurrency is managed by the Worker's semaphore, not by
 * the scheduler itself.
 */
export class GlobalJobScheduler<
  T extends JsonSerializable = JsonSerializable,
> extends BaseJobScheduler<T> {
  /**
   * Claim up to `count` jobs from the waiting list using an atomic Lua script.
   * Returns one entry per claimed job (empty when the waiting list was empty).
   *
   * By the time this runs the script has already RPOP'd and marked every entry
   * `active`, so a single malformed/undecodable entry must not throw — that
   * would poison the whole batch and abandon its healthy siblings to
   * lease-expiry. Each entry is decoded in isolation; a decode failure degrades
   * to a {@link CorruptJob} (best-effort jobId) so it costs one permit, not the
   * batch.
   *
   * ponytail: reuses the corrupt path — effect is identical (surface the
   * id once, drop the job); split the event kind only if the distinction earns
   * its keep.
   */
  async claimBatch(leaseMs: number, count: number): Promise<Exclude<ClaimResult<T>, null>[]> {
    const result = await this.client.claimGlobalBatch(this.keys, { leaseMs, tag: this.tag, count });

    if (!Array.isArray(result)) {
      throw new Error(`Unexpected claim result: ${String(result)}`);
    }
    return result.map((entry) => decodeClaimEntry<T>(entry));
  }
}
