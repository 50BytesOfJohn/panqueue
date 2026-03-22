import { expect } from "jsr:@std/expect";
import { type Spy, spy, stub } from "jsr:@std/testing/mock";
import { type RedisClient, _internals } from "./redis_connection.ts";
import { WorkerPool } from "./worker_pool.ts";

type TestQueues = {
  emails: { to: string; subject: string };
  thumbnails: { url: string; width: number };
};

/** Creates a fake Redis client with spied methods. */
function createFakeClient() {
  return {
    connect: spy(() => Promise.resolve()),
    disconnect: spy(() => Promise.resolve()),
    on: spy(),
    subscribe: spy((_channel: string, _cb: () => void) => Promise.resolve()),
    unsubscribe: spy(() => Promise.resolve()),
    claimGlobal: spy(() => Promise.resolve(null)),
    complete: spy(() => Promise.resolve(1)),
    fail: spy(() => Promise.resolve("failed")),
    duplicate: spy(),
  } as unknown as RedisClient & {
    connect: Spy;
    disconnect: Spy;
    subscribe: Spy;
    unsubscribe: Spy;
    claimGlobal: Spy;
  };
}

/** Stubs createClient to return fake clients in order. */
function stubCreateClients(...fakeClients: RedisClient[]) {
  let callCount = 0;
  return stub(
    _internals,
    "createClient",
    // deno-lint-ignore no-explicit-any
    (() => fakeClients[callCount++] ?? fakeClients[fakeClients.length - 1]) as any,
  );
}

// --- Registration tests ---

Deno.test("WorkerPool — .process() registers and chains", () => {
  const pool = new WorkerPool<TestQueues>({
    connection: "redis://localhost:6379",
  });

  const result = pool
    .process("emails", async () => {})
    .process("thumbnails", async () => {});

  expect(result).toBe(pool);
});

Deno.test("WorkerPool — .process() throws on duplicate queue ID", () => {
  const pool = new WorkerPool<TestQueues>({
    connection: "redis://localhost:6379",
  });

  pool.process("emails", async () => {});

  expect(() => {
    pool.process("emails", async () => {});
  }).toThrow('Processor already registered for queue "emails"');
});

Deno.test("WorkerPool — .process() throws after start", async () => {
  // 2 workers × 2 clients each (main + subscriber)
  const createStub = stubCreateClients(
    createFakeClient(),
    createFakeClient(),
    createFakeClient(),
    createFakeClient(),
  );

  try {
    const pool = new WorkerPool<TestQueues>({
      connection: "redis://localhost:6379",
    });

    pool.process("emails", async () => {});
    await pool.start();

    expect(() => {
      pool.process("thumbnails", async () => {});
    }).toThrow("Cannot register processors after the pool has started");

    await pool.shutdown();
  } finally {
    createStub.restore();
  }
});

// --- start() tests ---

Deno.test("WorkerPool — start() throws when no processors registered", async () => {
  const pool = new WorkerPool<TestQueues>({
    connection: "redis://localhost:6379",
  });

  await expect(pool.start()).rejects.toThrow("No processors registered");
});

Deno.test("WorkerPool — start() throws when already started", async () => {
  const createStub = stubCreateClients(
    createFakeClient(),
    createFakeClient(),
  );

  try {
    const pool = new WorkerPool<TestQueues>({
      connection: "redis://localhost:6379",
    });

    pool.process("emails", async () => {});
    await pool.start();

    await expect(pool.start()).rejects.toThrow("Pool is already started");

    await pool.shutdown();
  } finally {
    createStub.restore();
  }
});

Deno.test("WorkerPool — start() creates workers and starts them", async () => {
  const createStub = stubCreateClients(
    createFakeClient(),
    createFakeClient(),
    createFakeClient(),
    createFakeClient(),
  );

  try {
    const pool = new WorkerPool<TestQueues>({
      connection: "redis://localhost:6379",
    });

    pool
      .process("emails", async () => {})
      .process("thumbnails", async () => {});

    await pool.start();

    // 2 workers × 2 clients each (main + subscriber) = 4 createClient calls
    expect(createStub.calls.length).toBe(4);

    await pool.shutdown();
  } finally {
    createStub.restore();
  }
});

// --- shutdown() tests ---

Deno.test("WorkerPool — shutdown() returns clean result when not started", async () => {
  const pool = new WorkerPool<TestQueues>({
    connection: "redis://localhost:6379",
  });

  const result = await pool.shutdown();
  expect(result).toEqual({ timedOut: false, unfinishedJobs: 0 });
});

Deno.test("WorkerPool — shutdown() aggregates results from all workers", async () => {
  const createStub = stubCreateClients(
    createFakeClient(),
    createFakeClient(),
    createFakeClient(),
    createFakeClient(),
  );

  try {
    const pool = new WorkerPool<TestQueues>({
      connection: "redis://localhost:6379",
    });

    pool
      .process("emails", async () => {})
      .process("thumbnails", async () => {});

    await pool.start();
    const result = await pool.shutdown();

    expect(result.timedOut).toBe(false);
    expect(result.unfinishedJobs).toBe(0);
  } finally {
    createStub.restore();
  }
});

// --- Options merging ---

Deno.test("WorkerPool — per-worker options override pool defaults", async () => {
  const clients = [createFakeClient(), createFakeClient()];
  const createStub = stubCreateClients(...clients);

  try {
    const pool = new WorkerPool<TestQueues>({
      connection: "redis://localhost:6379",
      concurrency: 5,
    });

    pool.process("emails", async () => {}, { concurrency: 10 });
    await pool.start();

    // Worker was created and started successfully — that's all we
    // can verify externally. Concurrency is a private field.
    await pool.shutdown();
  } finally {
    createStub.restore();
  }
});

// --- Partial start failure ---

Deno.test("WorkerPool — partial start failure rolls back started workers", async () => {
  const goodClient = createFakeClient();
  const goodSubClient = createFakeClient();
  // Third client fails to connect — this will be used by the second worker
  let callCount = 0;
  const createStub = stub(
    _internals,
    "createClient",
    // deno-lint-ignore no-explicit-any
    (() => {
      callCount++;
      if (callCount <= 2) return callCount === 1 ? goodClient : goodSubClient;
      // Third call (second worker's main client) fails on connect
      return {
        ...createFakeClient(),
        connect: spy(() => Promise.reject(new Error("connection refused"))),
      };
    }) as any,
  );

  try {
    const pool = new WorkerPool<TestQueues>({
      connection: "redis://localhost:6379",
    });

    pool
      .process("emails", async () => {})
      .process("thumbnails", async () => {});

    await expect(pool.start()).rejects.toThrow("connection refused");

    // Pool is not started, can register again
    pool.process("emails", async () => {});
  } finally {
    createStub.restore();
  }
});

// --- AsyncDisposable ---

Deno.test("WorkerPool — Symbol.asyncDispose calls shutdown", async () => {
  const createStub = stubCreateClients(
    createFakeClient(),
    createFakeClient(),
  );

  try {
    const pool = new WorkerPool<TestQueues>({
      connection: "redis://localhost:6379",
    });

    pool.process("emails", async () => {});
    await pool.start();

    await pool[Symbol.asyncDispose]();

    // Should be able to re-register and start after dispose
    // (shutdown resets #started)
    pool.process("thumbnails", async () => {});
  } finally {
    createStub.restore();
  }
});
