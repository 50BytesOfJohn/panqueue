import { beforeEach, describe, expect, it, vi } from "vitest";

import { ClientClosedError, ClientConnectionError } from "./errors.js";
import { RedisConnection } from "./redis-connection.js";

const { createClientMock, connectMock, disconnectMock } = vi.hoisted(() => ({
  createClientMock: vi.fn(),
  connectMock: vi.fn(),
  disconnectMock: vi.fn(),
}));

vi.mock(import("redis"), async (importOriginal) => ({
  ...(await importOriginal()),
  createClient: createClientMock,
}));

let fakeClient: {
  on: ReturnType<typeof vi.fn>;
  connect: typeof connectMock;
  disconnect: typeof disconnectMock;
};

/** The options object passed to `createClient` by the most recent connect. */
const passedOptions = () => createClientMock.mock.calls[0][0];

beforeEach(() => {
  vi.clearAllMocks();
  fakeClient = { on: vi.fn(), connect: connectMock, disconnect: disconnectMock };
  createClientMock.mockImplementation(() => fakeClient);
});

describe("RedisConnection connection options", () => {
  it("uses a string connection as the url", async () => {
    // Arrange
    const connection = new RedisConnection("redis://host:6379");

    // Act
    await connection.connect();

    // Assert
    expect(passedOptions().url).toBe("redis://host:6379");
  });

  it("uses the url from a { url } object", async () => {
    // Arrange
    const connection = new RedisConnection({ url: "redis://host:6379" });

    // Act
    await connection.connect();

    // Assert
    expect(passedOptions().url).toBe("redis://host:6379");
  });

  it("maps host and port from parameter options", async () => {
    // Arrange
    const connection = new RedisConnection({ host: "example", port: 1234 });

    // Act
    await connection.connect();

    // Assert
    expect(passedOptions().socket).toMatchObject({ host: "example", port: 1234 });
  });

  it("defaults host to localhost and port to 6379 when omitted", async () => {
    // Arrange
    const connection = new RedisConnection({ password: "secret" });

    // Act
    await connection.connect();

    // Assert
    expect(passedOptions().socket).toMatchObject({ host: "localhost", port: 6379 });
  });

  it("enables tls in the socket when tls is set", async () => {
    // Arrange
    const connection = new RedisConnection({ host: "example", tls: true });

    // Act
    await connection.connect();

    // Assert
    expect(passedOptions().socket).toMatchObject({ host: "example", port: 6379, tls: true });
  });

  it("maps password from parameter options", async () => {
    // Arrange
    const connection = new RedisConnection({ password: "secret" });

    // Act
    await connection.connect();

    // Assert
    expect(passedOptions().password).toBe("secret");
  });

  it("maps db to the database option", async () => {
    // Arrange
    const connection = new RedisConnection({ db: 3 });

    // Act
    await connection.connect();

    // Assert
    expect(passedOptions().database).toBe(3);
  });
});

describe("RedisConnection.connect", () => {
  it("connects the underlying redis client", async () => {
    // Arrange
    const connection = new RedisConnection("redis://host:6379");

    // Act
    await connection.connect();

    // Assert
    expect(connectMock).toHaveBeenCalledOnce();
  });

  it("does not create a new client when already connected", async () => {
    // Arrange
    const connection = new RedisConnection("redis://host:6379");
    await connection.connect();

    // Act
    await connection.connect();

    // Assert
    expect(createClientMock).toHaveBeenCalledOnce();
  });

  it("deduplicates concurrent connect calls", async () => {
    // Arrange
    const connection = new RedisConnection("redis://host:6379");

    // Act
    await Promise.all([connection.connect(), connection.connect()]);

    // Assert
    expect(createClientMock).toHaveBeenCalledOnce();
  });
});

describe("RedisConnection.client", () => {
  it("throws when accessed before connecting", () => {
    // Arrange
    const connection = new RedisConnection("redis://host:6379");

    // Act & Assert
    expect(() => connection.client).toThrow("Redis client is not connected. Call connect() first.");
  });

  it("returns the connected client after connecting", async () => {
    // Arrange
    const connection = new RedisConnection("redis://host:6379");
    await connection.connect();

    // Act
    const client = connection.client;

    // Assert
    expect(client).toBe(fakeClient);
  });
});

describe("RedisConnection.disconnect", () => {
  it("disconnects the underlying client", async () => {
    // Arrange
    const connection = new RedisConnection("redis://host:6379");
    await connection.connect();

    // Act
    await connection.disconnect();

    // Assert
    expect(disconnectMock).toHaveBeenCalledOnce();
  });

  it("is a no-op when never connected", async () => {
    // Arrange
    const connection = new RedisConnection("redis://host:6379");

    // Act
    await connection.disconnect();

    // Assert
    expect(disconnectMock).not.toHaveBeenCalled();
  });

  it("is single-shot: connect after disconnect rejects with ClientClosedError", async () => {
    // Arrange
    const connection = new RedisConnection("redis://host:6379");
    await connection.connect();
    await connection.disconnect();

    // Act & Assert
    await expect(connection.connect()).rejects.toBeInstanceOf(ClientClosedError);
    expect(createClientMock).toHaveBeenCalledOnce();
  });

  it("rejects client access after disconnect with ClientClosedError", async () => {
    // Arrange
    const connection = new RedisConnection("redis://host:6379");
    await connection.connect();
    await connection.disconnect();

    // Act & Assert
    expect(() => connection.client).toThrow(ClientClosedError);
  });
});

describe("RedisConnection producer defaults", () => {
  it("disables the offline queue so commands fail fast while disconnected", async () => {
    // Arrange
    const connection = new RedisConnection("redis://host:6379");

    // Act
    await connection.connect();

    // Assert
    expect(passedOptions().disableOfflineQueue).toBe(true);
  });

  it("configures a reconnect strategy on the socket", async () => {
    // Arrange
    const connection = new RedisConnection("redis://host:6379");

    // Act
    await connection.connect();

    // Assert
    expect(typeof passedOptions().socket.reconnectStrategy).toBe("function");
  });

  it("gives up the initial connect after a few attempts", async () => {
    // Arrange
    const connection = new RedisConnection("redis://host:6379");
    await connection.connect();
    const strategy = passedOptions().socket.reconnectStrategy;
    const cause = new Error("ECONNREFUSED");

    // Act & Assert — never connected: bounded retries, then surface the cause.
    expect(typeof strategy(0, cause)).toBe("number");
    expect(strategy(3, cause)).toBe(cause);
  });

  it("reconnects indefinitely once a connection was established", async () => {
    // Arrange
    const connection = new RedisConnection("redis://host:6379");
    await connection.connect();
    const readyListener = fakeClient.on.mock.calls.find(([event]) => event === "ready")?.[1];
    readyListener();

    // Act
    const delay = passedOptions().socket.reconnectStrategy(100, new Error("socket closed"));

    // Assert
    expect(typeof delay).toBe("number");
  });

  it("wraps connect failures in ClientConnectionError", async () => {
    // Arrange
    connectMock.mockRejectedValueOnce(new Error("ECONNREFUSED"));
    const connection = new RedisConnection("redis://host:6379");

    // Act & Assert
    await expect(connection.connect()).rejects.toBeInstanceOf(ClientConnectionError);
  });

  it("retries the connection on a later connect after a failed one", async () => {
    // Arrange
    connectMock.mockRejectedValueOnce(new Error("ECONNREFUSED"));
    const connection = new RedisConnection("redis://host:6379");
    await connection.connect().catch(() => {});

    // Act
    await connection.connect();

    // Assert
    expect(createClientMock).toHaveBeenCalledTimes(2);
  });
});

describe("RedisConnection lifecycle hooks", () => {
  it("forwards socket error events to the onError hook", async () => {
    // Arrange
    const onError = vi.fn();
    const connection = new RedisConnection("redis://host:6379", { onError });
    await connection.connect();
    const errorListener = fakeClient.on.mock.calls.find(([event]) => event === "error")?.[1];
    const socketError = new Error("socket boom");

    // Act
    errorListener(socketError);

    // Assert
    expect(onError).toHaveBeenCalledWith(socketError);
  });

  it("forwards reconnecting and ready events to their hooks", async () => {
    // Arrange
    const onReconnecting = vi.fn();
    const onReady = vi.fn();
    const connection = new RedisConnection("redis://host:6379", { onReconnecting, onReady });
    await connection.connect();
    const listener = (name: string) =>
      fakeClient.on.mock.calls.find(([event]) => event === name)?.[1];

    // Act
    listener("reconnecting")();
    listener("ready")();

    // Assert
    expect(onReconnecting).toHaveBeenCalledOnce();
    expect(onReady).toHaveBeenCalledOnce();
  });
});

describe("RedisConnection async dispose", () => {
  it("disconnects the client on dispose", async () => {
    // Arrange
    const connection = new RedisConnection("redis://host:6379");
    await connection.connect();

    // Act
    await connection[Symbol.asyncDispose]();

    // Assert
    expect(disconnectMock).toHaveBeenCalledOnce();
  });
});
