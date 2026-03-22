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

/** Stubs createClient to return the given fake. */
function stubCreateClient(fakeClient: RedisClient) {
  return stub(
    _internals,
    "createClient",
    // deno-lint-ignore no-explicit-any
    (() => fakeClient) as any,
  );
}

Deno.test("connect creates and connects a Redis client", async () => {
  const fakeClient = createFakeClient();
  const createStub = stubCreateClient(fakeClient);
  try {
    const conn = new RedisConnection("redis://localhost:6379");
    await conn.connect();

    assertSpyCalls(fakeClient.connect, 1);
    expect(conn.client).toBe(fakeClient);
  } finally {
    createStub.restore();
  }
});

Deno.test("connect is idempotent", async () => {
  const fakeClient = createFakeClient();
  const createStub = stubCreateClient(fakeClient);
  try {
    const conn = new RedisConnection("redis://localhost:6379");
    await conn.connect();
    await conn.connect();

    assertSpyCalls(fakeClient.connect, 1);
  } finally {
    createStub.restore();
  }
});

Deno.test("client throws before connect", () => {
  const conn = new RedisConnection("redis://localhost:6379");
  expect(() => conn.client).toThrow("not connected");
});

Deno.test("disconnect calls client disconnect", async () => {
  const fakeClient = createFakeClient();
  const createStub = stubCreateClient(fakeClient);
  try {
    const conn = new RedisConnection("redis://localhost:6379");
    await conn.connect();
    await conn.disconnect();

    assertSpyCalls(fakeClient.disconnect, 1);
    expect(() => conn.client).toThrow("not connected");
  } finally {
    createStub.restore();
  }
});

Deno.test("duplicate creates a new connected instance", async () => {
  const fakeClient1 = createFakeClient();
  const fakeClient2 = createFakeClient();
  let callCount = 0;
  const createStub = stub(
    _internals,
    "createClient",
    // deno-lint-ignore no-explicit-any
    (() => (callCount++ === 0 ? fakeClient1 : fakeClient2)) as any,
  );
  try {
    const conn = new RedisConnection("redis://localhost:6379");
    await conn.connect();
    const dup = await conn.duplicate();

    expect(dup.client).toBe(fakeClient2);
    assertSpyCalls(fakeClient2.connect, 1);
  } finally {
    createStub.restore();
  }
});

Deno.test("Symbol.asyncDispose calls disconnect", async () => {
  const fakeClient = createFakeClient();
  const createStub = stubCreateClient(fakeClient);
  try {
    const conn = new RedisConnection("redis://localhost:6379");
    await conn.connect();
    await conn[Symbol.asyncDispose]();

    assertSpyCalls(fakeClient.disconnect, 1);
  } finally {
    createStub.restore();
  }
});
