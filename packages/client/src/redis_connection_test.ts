import { expect } from "jsr:@std/expect";
import { assertSpyCalls, type Spy, spy, stub } from "jsr:@std/testing/mock";
import {
  type RedisClient,
  RedisConnection,
  _internals,
} from "./redis_connection.ts";

/** Creates a fake Redis client with spied methods. */
function createFakeClient() {
  return {
    connect: spy(() => Promise.resolve()),
    disconnect: spy(() => Promise.resolve()),
    on: spy(),
  } as unknown as RedisClient & {
    connect: Spy;
    disconnect: Spy;
    on: Spy;
  };
}

/** Stubs createClient to return the given fake, returns the stub for assertions. */
function stubCreateClient(fakeClient: RedisClient) {
  return stub(
    _internals,
    "createClient",
    // deno-lint-ignore no-explicit-any
    (() => fakeClient) as any,
  );
}

Deno.test("client getter throws when not connected", () => {
  // Arrange
  const conn = new RedisConnection("redis://localhost:6379");

  // Act & Assert
  expect(() => conn.client).toThrow(
    "[panqueue] Redis client is not connected. Call connect() first.",
  );
});

Deno.test("connect() makes the client accessible", async () => {
  // Arrange
  const fakeClient = createFakeClient();
  using _stub = stubCreateClient(fakeClient);
  const conn = new RedisConnection("redis://localhost:6379");

  // Act
  await conn.connect();

  // Assert
  expect(conn.client).toBe(fakeClient);
});

Deno.test("connect() registers an error handler on the client", async () => {
  // Arrange
  const fakeClient = createFakeClient();
  using _stub = stubCreateClient(fakeClient);
  const conn = new RedisConnection("redis://localhost:6379");

  // Act
  await conn.connect();

  // Assert
  expect(fakeClient.on.calls[0]?.args[0]).toBe("error");
});

Deno.test("connect() does not reconnect when already connected", async () => {
  // Arrange
  const fakeClient = createFakeClient();
  const createClientStub = stubCreateClient(fakeClient);
  const conn = new RedisConnection("redis://localhost:6379");
  await conn.connect();

  // Act
  await conn.connect();

  // Assert
  assertSpyCalls(createClientStub, 1);
  createClientStub.restore();
});

Deno.test(
  "concurrent connect() calls result in a single connection",
  async () => {
    // Arrange
    const fakeClient = createFakeClient();
    const createClientStub = stubCreateClient(fakeClient);
    const conn = new RedisConnection("redis://localhost:6379");

    // Act
    await Promise.all([conn.connect(), conn.connect(), conn.connect()]);

    // Assert
    assertSpyCalls(createClientStub, 1);
    createClientStub.restore();
  },
);

Deno.test("disconnect() is safe to call when not connected", async () => {
  // Arrange
  const conn = new RedisConnection("redis://localhost:6379");

  // Act & Assert (should not throw)
  await conn.disconnect();
});

Deno.test("disconnect() makes client inaccessible again", async () => {
  // Arrange
  const fakeClient = createFakeClient();
  using _stub = stubCreateClient(fakeClient);
  const conn = new RedisConnection("redis://localhost:6379");
  await conn.connect();

  // Act
  await conn.disconnect();

  // Assert
  expect(() => conn.client).toThrow();
});

Deno.test("disconnect() calls disconnect on the underlying client", async () => {
  // Arrange
  const fakeClient = createFakeClient();
  using _stub = stubCreateClient(fakeClient);
  const conn = new RedisConnection("redis://localhost:6379");
  await conn.connect();

  // Act
  await conn.disconnect();

  // Assert
  assertSpyCalls(fakeClient.disconnect as unknown as Spy, 1);
});

Deno.test("Symbol.asyncDispose disconnects the client", async () => {
  // Arrange
  const fakeClient = createFakeClient();
  using _stub = stubCreateClient(fakeClient);
  const conn = new RedisConnection("redis://localhost:6379");
  await conn.connect();

  // Act
  await conn[Symbol.asyncDispose]();

  // Assert
  expect(() => conn.client).toThrow();
});

Deno.test("duplicate() returns a separate connected instance", async () => {
  // Arrange
  const fakeClient1 = createFakeClient();
  const fakeClient2 = createFakeClient();
  let callCount = 0;
  // deno-lint-ignore no-explicit-any
  using _stub = stub(_internals, "createClient", (() => {
    callCount++;
    return callCount === 1 ? fakeClient1 : fakeClient2;
  }) as any);
  const conn = new RedisConnection("redis://localhost:6379");
  await conn.connect();

  // Act
  const dup = await conn.duplicate();

  // Assert
  expect(dup.client).not.toBe(conn.client);
});

Deno.test("connect() passes URL string to createClient", async () => {
  // Arrange
  const fakeClient = createFakeClient();
  const createClientStub = stubCreateClient(fakeClient);
  const url = "redis://myhost:6380/2";

  // Act
  const conn = new RedisConnection(url);
  await conn.connect();

  // Assert
  expect(createClientStub.calls[0]?.args[0]).toEqual({ url });
  createClientStub.restore();
});

Deno.test("connect() maps object options to redis client format", async () => {
  // Arrange
  const fakeClient = createFakeClient();
  const createClientStub = stubCreateClient(fakeClient);

  // Act
  const conn = new RedisConnection({
    host: "myhost",
    port: 6380,
    password: "secret",
    db: 2,
    tls: true,
  });
  await conn.connect();

  // Assert
  expect(createClientStub.calls[0]?.args[0]).toEqual({
    socket: { host: "myhost", port: 6380, tls: true },
    password: "secret",
    database: 2,
  });
  createClientStub.restore();
});

Deno.test("connect() uses default host and port when not specified", async () => {
  // Arrange
  const fakeClient = createFakeClient();
  const createClientStub = stubCreateClient(fakeClient);

  // Act
  const conn = new RedisConnection({});
  await conn.connect();

  // Assert
  expect(createClientStub.calls[0]?.args[0]).toEqual({
    socket: { host: "localhost", port: 6379, tls: false },
    password: undefined,
    database: undefined,
  });
  createClientStub.restore();
});
