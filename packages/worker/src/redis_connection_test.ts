import { expect } from "jsr:@std/expect";
import { assertSpyCalls, type Spy, spy, stub } from "jsr:@std/testing/mock";
import {
  _internals,
  type PanqueueSubscriber,
  type PanqueueWorkerClient,
  RedisConnection,
} from "./redis_connection.ts";

type FakeClient =
  & PanqueueWorkerClient
  & PanqueueSubscriber
  & {
    connect: Spy;
    disconnect: Spy;
    on: Spy;
    subscribe: Spy;
    unsubscribe: Spy;
    claimGlobal: Spy;
  };

/** Creates a fake Redis client with spied methods. */
function createFakeClient(): FakeClient {
  return {
    connect: spy(() => Promise.resolve()),
    disconnect: spy(() => Promise.resolve()),
    on: spy(),
    subscribe: spy(() => Promise.resolve()),
    unsubscribe: spy(() => Promise.resolve()),
    claimGlobal: spy(() => Promise.resolve(null)),
    complete: spy(() => Promise.resolve("completed")),
    fail: spy(() => Promise.resolve("failed")),
    recover: spy(() => Promise.resolve([])),
    extendLock: spy(() => Promise.resolve("extended")),
    requeueActive: spy(() => Promise.resolve("waiting")),
  } as unknown as FakeClient;
}

/** Stubs createClient to return the given fake. */
function stubCreateClient(fakeClient: FakeClient) {
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
    await conn.client.claimGlobal(
      "waiting",
      "active",
      "jobs",
      "corrupt",
      "corrupt:data",
      "30000",
    );
    assertSpyCalls(fakeClient.claimGlobal, 1);
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

Deno.test("duplicate creates a new connected subscriber instance", async () => {
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

    await dup.client.subscribe("channel", () => {});
    assertSpyCalls(fakeClient2.subscribe as unknown as Spy, 1);
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
