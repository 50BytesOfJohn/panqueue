import { expect } from "jsr:@std/expect";
import { assertSpyCalls, type Spy, spy, stub } from "jsr:@std/testing/mock";
import {
  type RedisClient,
  RedisConnection,
  _internals,
} from "./redis_connection.ts";
import { QueueClient } from "./queue_client.ts";

type TestQueues = {
  emails: { to: string; subject: string };
};

/** Creates a fake Redis client with spied methods including eval. */
function createFakeClient() {
  return {
    connect: spy(() => Promise.resolve()),
    disconnect: spy(() => Promise.resolve()),
    on: spy(),
    eval: spy(() => Promise.resolve("fake-id")),
  } as unknown as RedisClient & {
    connect: Spy;
    disconnect: Spy;
    on: Spy;
    eval: Spy;
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

/** Helper: create a connected QueueClient with a fake Redis client. */
async function setup() {
  const fakeClient = createFakeClient();
  const createStub = stubCreateClient(fakeClient);
  const client = new QueueClient<TestQueues>({
    connection: "redis://localhost:6379",
  });
  await client.connect();
  return { fakeClient, createStub, client };
}

Deno.test("enqueue stores job data and pushes to waiting list via Lua", async () => {
  const { fakeClient, createStub, client } = await setup();
  try {
    await client.enqueue("emails", { to: "a@b.com", subject: "Hi" });

    assertSpyCalls(fakeClient.eval as unknown as Spy, 1);
    const call = (fakeClient.eval as unknown as Spy).calls[0];
    const opts = call.args[1];

    expect(opts.keys[0]).toBe("{q:emails}:jobs");
    expect(opts.keys[1]).toBe("{q:emails}:waiting");
    expect(opts.keys[2]).toBe("{q:emails}:notify");

    // The serialized job data should contain the payload
    const jobData = JSON.parse(opts.arguments[1]);
    expect(jobData.data).toEqual({ to: "a@b.com", subject: "Hi" });
    expect(jobData.queueId).toBe("emails");
    expect(jobData.status).toBe("waiting");
    expect(jobData.attempts).toBe(0);
  } finally {
    createStub.restore();
  }
});

Deno.test("enqueue publishes notification via Lua script keys", async () => {
  const { fakeClient, createStub, client } = await setup();
  try {
    await client.enqueue("emails", { to: "a@b.com", subject: "Hi" });

    const call = (fakeClient.eval as unknown as Spy).calls[0];
    const opts = call.args[1];

    // Third key is the notify channel
    expect(opts.keys[2]).toBe("{q:emails}:notify");
  } finally {
    createStub.restore();
  }
});

Deno.test("enqueue returns a job ID", async () => {
  const { createStub, client } = await setup();
  try {
    const jobId = await client.enqueue("emails", {
      to: "a@b.com",
      subject: "Hi",
    });

    expect(typeof jobId).toBe("string");
    expect(jobId.length).toBeGreaterThan(0);
  } finally {
    createStub.restore();
  }
});

Deno.test("enqueue with custom jobId uses it", async () => {
  const { fakeClient, createStub, client } = await setup();
  try {
    const jobId = await client.enqueue(
      "emails",
      { to: "a@b.com", subject: "Hi" },
      { jobId: "my-custom-id" },
    );

    expect(jobId).toBe("my-custom-id");

    const call = (fakeClient.eval as unknown as Spy).calls[0];
    const opts = call.args[1];
    expect(opts.arguments[0]).toBe("my-custom-id");

    const jobData = JSON.parse(opts.arguments[1]);
    expect(jobData.id).toBe("my-custom-id");
  } finally {
    createStub.restore();
  }
});

Deno.test("enqueue rejects non-JSON-serializable payloads", async () => {
  const { createStub, client } = await setup();
  try {
    await expect(
      // deno-lint-ignore no-explicit-any
      client.enqueue("emails", { to: "a@b.com", subject: () => {} } as any),
    ).rejects.toThrow(TypeError);
  } finally {
    createStub.restore();
  }
});

Deno.test("enqueue sets maxRetries from options", async () => {
  const { fakeClient, createStub, client } = await setup();
  try {
    await client.enqueue(
      "emails",
      { to: "a@b.com", subject: "Hi" },
      { retries: 3 },
    );

    const call = (fakeClient.eval as unknown as Spy).calls[0];
    const jobData = JSON.parse(call.args[1].arguments[1]);
    expect(jobData.maxRetries).toBe(3);
  } finally {
    createStub.restore();
  }
});
