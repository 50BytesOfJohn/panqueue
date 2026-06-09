import { beforeEach, describe, expect, it, vi } from "vitest";

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
    expect(passedOptions().socket).toEqual({ host: "example", port: 1234 });
  });

  it("defaults host to localhost and port to 6379 when omitted", async () => {
    // Arrange
    const connection = new RedisConnection({ password: "secret" });

    // Act
    await connection.connect();

    // Assert
    expect(passedOptions().socket).toEqual({ host: "localhost", port: 6379 });
  });

  it("enables tls in the socket when tls is set", async () => {
    // Arrange
    const connection = new RedisConnection({ host: "example", tls: true });

    // Act
    await connection.connect();

    // Assert
    expect(passedOptions().socket).toEqual({ host: "example", port: 6379, tls: true });
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

  it("allows reconnecting after disconnect", async () => {
    // Arrange
    const connection = new RedisConnection("redis://host:6379");
    await connection.connect();
    await connection.disconnect();

    // Act
    await connection.connect();

    // Assert
    expect(createClientMock).toHaveBeenCalledTimes(2);
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
