import { PanqueueError, queueKeys } from "@panqueue/core";
import { describe, expect, it } from "vitest";

import { ConcurrencyLimitConflictError } from "../errors.js";
import type { PanqueueWorkerClient } from "../redis-connection.js";
import { declareConcurrencyLimit } from "./concurrency-fence.js";

/** Fake client exposing only `declareConcurrencyLimit`, recording its args. */
function fakeClient(reply: unknown): {
  client: PanqueueWorkerClient;
  calls: { keys: unknown; args: unknown }[];
} {
  const calls: { keys: unknown; args: unknown }[] = [];
  const client = {
    declareConcurrencyLimit: async (keys: unknown, args: unknown) => {
      calls.push({ keys, args });
      return reply;
    },
  } as unknown as PanqueueWorkerClient;
  return { client, calls };
}

describe("declareConcurrencyLimit", () => {
  it("writes when the key is absent", async () => {
    // Arrange
    const { client, calls } = fakeClient(["written", 10]);

    // Act
    await declareConcurrencyLimit(client, "q", { limit: 10, version: 1 });

    // Assert
    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual({ keys: queueKeys("q"), args: { limit: 10, version: 1 } });
  });

  it("overwrites on a higher version", async () => {
    // Arrange
    const { client } = fakeClient(["written", 5]);

    // Act / Assert — resolves without throwing.
    await expect(
      declareConcurrencyLimit(client, "q", { limit: 5, version: 2 }),
    ).resolves.toBeUndefined();
  });

  it("silently ignores a lower version", async () => {
    // Arrange
    const { client } = fakeClient(["ignored", 10]);

    // Act / Assert
    await expect(
      declareConcurrencyLimit(client, "q", { limit: 3, version: 1 }),
    ).resolves.toBeUndefined();
  });

  it("is idempotent for same version and limit", async () => {
    // Arrange
    const { client } = fakeClient(["unchanged", 10]);

    // Act / Assert
    await expect(
      declareConcurrencyLimit(client, "q", { limit: 10, version: 2 }),
    ).resolves.toBeUndefined();
  });

  it("throws ConcurrencyLimitConflictError on same version, different limit", async () => {
    // Arrange
    const { client } = fakeClient(["conflict", 10]);

    // Act
    const err = await declareConcurrencyLimit(client, "q", { limit: 5, version: 3 }).catch(
      (e: unknown) => e,
    );

    // Assert — the conflict is a PanqueueError whose message names the queue,
    // both limits, and the version.
    expect(err).toBeInstanceOf(ConcurrencyLimitConflictError);
    expect(err).toBeInstanceOf(PanqueueError);
    const message = (err as Error).message;
    expect(message).toContain("q");
    expect(message).toContain("10");
    expect(message).toContain("5");
    expect(message).toContain("3");
  });

  it("throws on an unexpected reply shape", async () => {
    // Arrange
    const { client } = fakeClient("nope");

    // Act / Assert
    await expect(declareConcurrencyLimit(client, "q", { limit: 1, version: 1 })).rejects.toThrow(
      "Unexpected declareConcurrencyLimit result",
    );
  });
});
