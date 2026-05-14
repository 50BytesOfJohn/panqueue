import { expect } from "jsr:@std/expect";
import { assertSpyCalls, type Spy, spy, stub } from "jsr:@std/testing/mock";
import { _internals, type PanqueueProducerClient } from "./redis_connection.ts";
import { QueueClient } from "./queue_client.ts";

type TestQueues = {
  emails: { to: string; subject: string };
};

type FakeClient = PanqueueProducerClient & {
  connect: Spy;
  disconnect: Spy;
  on: Spy;
  enqueue: Spy;
};

/** Creates a fake Redis client with spied methods including enqueue. */
function createFakeClient(): FakeClient {
  return {
    connect: spy(() => Promise.resolve()),
    disconnect: spy(() => Promise.resolve()),
    on: spy(),
    enqueue: spy(() => Promise.resolve("fake-id")),
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

    // enqueue(jobsKey, waitingKey, notifyKey, jobId, serialized)
    assertSpyCalls(fakeClient.enqueue as unknown as Spy, 1);
    const call = (fakeClient.enqueue as unknown as Spy).calls[0];

    expect(call.args[0]).toBe("{q:emails}:jobs");
    expect(call.args[1]).toBe("{q:emails}:waiting");
    expect(call.args[2]).toBe("{q:emails}:notify");

    // The serialized job data should contain the payload
    const jobData = JSON.parse(call.args[4]);
    expect(jobData.data).toEqual({ to: "a@b.com", subject: "Hi" });
    expect(jobData.queueId).toBe("emails");
    expect(jobData.status).toBe("waiting");
    expect(jobData.runs).toBe(0);
    expect(jobData.failures).toBe(0);
    expect(jobData.stalls).toBe(0);
  } finally {
    createStub.restore();
  }
});

Deno.test("enqueue publishes notification via Lua script keys", async () => {
  const { fakeClient, createStub, client } = await setup();
  try {
    await client.enqueue("emails", { to: "a@b.com", subject: "Hi" });

    const call = (fakeClient.enqueue as unknown as Spy).calls[0];

    // Third positional arg is the notify channel
    expect(call.args[2]).toBe("{q:emails}:notify");
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

Deno.test("enqueue stores the generated job ID in the job data", async () => {
  const { fakeClient, createStub, client } = await setup();
  try {
    const jobId = await client.enqueue("emails", {
      to: "a@b.com",
      subject: "Hi",
    });

    // enqueue(jobsKey, waitingKey, notifyKey, jobId, serialized)
    const call = (fakeClient.enqueue as unknown as Spy).calls[0];
    expect(call.args[3]).toBe(jobId);

    const jobData = JSON.parse(call.args[4]);
    expect(jobData.id).toBe(jobId);
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

    // enqueue(jobsKey, waitingKey, notifyKey, jobId, serialized)
    const call = (fakeClient.enqueue as unknown as Spy).calls[0];
    const jobData = JSON.parse(call.args[4]);
    expect(jobData.maxRetries).toBe(3);
  } finally {
    createStub.restore();
  }
});

Deno.test("enqueue sets maxStalls from options", async () => {
  const { fakeClient, createStub, client } = await setup();
  try {
    await client.enqueue(
      "emails",
      { to: "a@b.com", subject: "Hi" },
      { maxStalls: 2 },
    );

    const call = (fakeClient.enqueue as unknown as Spy).calls[0];
    const jobData = JSON.parse(call.args[4]);
    expect(jobData.maxStalls).toBe(2);
  } finally {
    createStub.restore();
  }
});
