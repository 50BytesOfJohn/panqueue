import { jobsKey, notifyKey, waitingKey } from "@panqueue/core";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { createQueueClient, QueueClient } from "./queue-client.js";
import { RedisConnection } from "./redis-connection.js";

const { connectMock, disconnectMock, enqueueMock } = vi.hoisted(() => ({
  connectMock: vi.fn(),
  disconnectMock: vi.fn(),
  enqueueMock: vi.fn(),
}));

vi.mock("./redis-connection.js", () => ({
  RedisConnection: vi.fn(function () {
    return {
      connect: connectMock,
      disconnect: disconnectMock,
      client: { enqueue: enqueueMock },
    };
  }),
}));

type TestQueues = {
  emails: { to: string; subject: string };
};

const makeClient = () => new QueueClient<TestQueues>({ connection: "redis://localhost:6379" });

/** The serialized JobData sent to Redis by the most recent enqueue call. */
const lastSentJob = () => JSON.parse(enqueueMock.mock.calls[0][4]);

beforeEach(() => {
  vi.clearAllMocks();
});

describe("QueueClient.enqueue", () => {
  it("rejects a payload that is not JSON-serializable", async () => {
    // Arrange
    const client = makeClient();
    const invalid = { to: "a@b.com", subject: new Date() };

    // Act & Assert
    // @ts-expect-error - Date is not a valid payload type
    await expect(client.enqueue("emails", invalid)).rejects.toThrow(TypeError);
  });

  it("does not send to Redis when the payload is invalid", async () => {
    // Arrange
    const client = makeClient();
    const invalid = { to: "a@b.com", subject: new Date() };

    // Act
    // @ts-expect-error - Date is not a valid payload type
    await client.enqueue("emails", invalid).catch(() => {});

    // Assert
    expect(enqueueMock).not.toHaveBeenCalled();
  });

  it("defaults maxRetries to 0", async () => {
    // Arrange
    const client = makeClient();

    // Act
    await client.enqueue("emails", { to: "a@b.com", subject: "Hi" });

    // Assert
    expect(lastSentJob().maxRetries).toBe(0);
  });

  it("defaults maxStalls to 5", async () => {
    // Arrange
    const client = makeClient();

    // Act
    await client.enqueue("emails", { to: "a@b.com", subject: "Hi" });

    // Assert
    expect(lastSentJob().maxStalls).toBe(5);
  });

  it("derives the Redis keys from the queue id", async () => {
    // Arrange
    const client = makeClient();

    // Act
    await client.enqueue("emails", { to: "a@b.com", subject: "Hello" });

    // Assert
    expect(enqueueMock.mock.calls[0].slice(0, 3)).toEqual([
      jobsKey("emails"),
      waitingKey("emails"),
      notifyKey("emails"),
    ]);
  });

  it("uses the retries option as maxRetries", async () => {
    // Arrange
    const client = makeClient();

    // Act
    await client.enqueue(
      "emails",
      { to: "a@b.com", subject: "Hi" },
      {
        retries: 3,
      },
    );

    // Assert
    expect(lastSentJob().maxRetries).toBe(3);
  });

  it("uses the maxStalls option as maxStalls", async () => {
    // Arrange
    const client = makeClient();

    // Act
    await client.enqueue(
      "emails",
      { to: "a@b.com", subject: "Hi" },
      {
        maxStalls: 9,
      },
    );

    // Assert
    expect(lastSentJob().maxStalls).toBe(9);
  });

  it("connects lazily before sending", async () => {
    // Arrange
    const client = makeClient();

    // Act
    await client.enqueue("emails", { to: "a@b.com", subject: "Hi" });

    // Assert
    expect(connectMock).toHaveBeenCalledOnce();
  });
});

describe("QueueClient.disconnect", () => {
  it("closes the underlying Redis connection", async () => {
    // Arrange
    const client = makeClient();

    // Act
    await client.disconnect();

    // Assert
    expect(disconnectMock).toHaveBeenCalledOnce();
  });
});

describe("createQueueClient", () => {
  it("builds the connection from the config's redis option", () => {
    // Arrange
    const config = {
      redis: "redis://example:6379",
      queues: { emails: {} },
    };

    // Act
    createQueueClient<TestQueues>(config);

    // Assert
    expect(RedisConnection).toHaveBeenCalledWith("redis://example:6379");
  });
});
