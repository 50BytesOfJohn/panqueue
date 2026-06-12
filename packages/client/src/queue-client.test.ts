import { ErrorReply } from "redis";

import type { PanqueueConfig } from "@panqueue/config";
import { queueKeys, SerializationError } from "@panqueue/core";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { ClientConnectionError, EnqueueError } from "./errors.js";
import { QueueClient } from "./queue-client.js";
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

const makeClient = () => new QueueClient<TestQueues>({ redis: "redis://localhost:6379" });

/** The non-key enqueue args sent to Redis by the most recent enqueue call. */
const lastSentArgs = () => enqueueMock.mock.calls[0][1];

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
    await expect(client.enqueue("emails", invalid)).rejects.toBeInstanceOf(SerializationError);
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
    expect(lastSentArgs().maxRetries).toBe(0);
  });

  it("defaults maxStalls to 5", async () => {
    // Arrange
    const client = makeClient();

    // Act
    await client.enqueue("emails", { to: "a@b.com", subject: "Hi" });

    // Assert
    expect(lastSentArgs().maxStalls).toBe(5);
  });

  it("derives the Redis key bundle from the queue id", async () => {
    // Arrange
    const client = makeClient();

    // Act
    await client.enqueue("emails", { to: "a@b.com", subject: "Hello" });

    // Assert
    expect(enqueueMock.mock.calls[0][0]).toEqual(queueKeys("emails"));
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
    expect(lastSentArgs().maxRetries).toBe(3);
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
    expect(lastSentArgs().maxStalls).toBe(9);
  });

  it("sends the payload as the verbatim JSON of the data", async () => {
    // Arrange
    const client = makeClient();
    const data = { to: "a@b.com", subject: "Hi" };

    // Act
    await client.enqueue("emails", data);

    // Assert — opaque string, byte-identical to JSON.stringify; queueId/tag set.
    expect(lastSentArgs().payload).toBe(JSON.stringify(data));
    expect(lastSentArgs().queueId).toBe("emails");
    expect(lastSentArgs().tag).toBe("{q:emails}");
  });

  it("connects lazily before sending", async () => {
    // Arrange
    const client = makeClient();

    // Act
    await client.enqueue("emails", { to: "a@b.com", subject: "Hi" });

    // Assert
    expect(connectMock).toHaveBeenCalledOnce();
  });

  it("wraps a Redis error reply in EnqueueError carrying the queue id", async () => {
    // Arrange
    const client = makeClient();
    enqueueMock.mockRejectedValueOnce(new ErrorReply("ERR something broke"));

    // Act
    const error = await client.enqueue("emails", { to: "a@b.com", subject: "Hi" }).catch((e) => e);

    // Assert
    expect(error).toBeInstanceOf(EnqueueError);
    expect(error.queueId).toBe("emails");
  });

  it("wraps a transport failure in ClientConnectionError", async () => {
    // Arrange
    const client = makeClient();
    enqueueMock.mockRejectedValueOnce(new Error("Socket closed unexpectedly"));

    // Act & Assert
    await expect(client.enqueue("emails", { to: "a@b.com", subject: "Hi" })).rejects.toBeInstanceOf(
      ClientConnectionError,
    );
  });

  it("rethrows Panqueue errors from the connection unchanged", async () => {
    // Arrange
    const client = makeClient();
    const connectionError = new ClientConnectionError(new Error("ECONNREFUSED"));
    enqueueMock.mockRejectedValueOnce(connectionError);

    // Act & Assert
    await expect(client.enqueue("emails", { to: "a@b.com", subject: "Hi" })).rejects.toBe(
      connectionError,
    );
  });
});

describe("QueueClient connection events", () => {
  it("forwards connection events to the configured handlers", () => {
    // Arrange
    const onConnectionError = vi.fn();
    const onConnectionReady = vi.fn();
    const client = new QueueClient<TestQueues>(
      { redis: "redis://localhost:6379" },
      { events: { onConnectionError, onConnectionReady } },
    );
    expect(client).toBeInstanceOf(QueueClient);
    const [, hooks = {}] = vi.mocked(RedisConnection).mock.calls[0];
    const socketError = new Error("socket boom");

    // Act
    hooks.onError?.(socketError);
    hooks.onReady?.();

    // Assert
    expect(onConnectionError).toHaveBeenCalledWith({ error: socketError });
    expect(onConnectionReady).toHaveBeenCalledOnce();
  });

  it("swallows a throwing connection event handler", () => {
    // Arrange
    const client = new QueueClient<TestQueues>(
      { redis: "redis://localhost:6379" },
      {
        events: {
          onConnectionError: () => {
            throw new Error("handler boom");
          },
        },
      },
    );
    expect(client).toBeInstanceOf(QueueClient);
    const [, hooks = {}] = vi.mocked(RedisConnection).mock.calls[0];

    // Act & Assert — the hook must never propagate handler failures.
    expect(() => hooks.onError?.(new Error("socket boom"))).not.toThrow();
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

describe("QueueClient constructor", () => {
  it("builds the connection from the config's redis option", () => {
    // Arrange
    const config = {
      redis: "redis://example:6379",
    };

    // Act
    const client = new QueueClient<TestQueues>(config);

    // Assert
    expect(client).toBeInstanceOf(QueueClient);
    expect(RedisConnection).toHaveBeenCalledWith("redis://example:6379", expect.any(Object));
  });

  it("infers queue types from a shared PanqueueConfig", async () => {
    // Arrange
    const config: PanqueueConfig<TestQueues> = {
      redis: "redis://example:6379",
      queues: { emails: {} },
    };

    // Act
    const client = new QueueClient(config);
    await client.enqueue("emails", { to: "a@b.com", subject: "Hi" });

    // Assert — "emails" type-checks without an explicit generic; unknown queues don't.
    // @ts-expect-error - queue id not present in the config's queue map
    await client.enqueue("unknown", {}).catch(() => {});
    expect(lastSentArgs().queueId).toBe("emails");
  });
});
