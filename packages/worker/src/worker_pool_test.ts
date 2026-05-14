import { expect } from "jsr:@std/expect";
import { type Spy, spy, stub } from "jsr:@std/testing/mock";
import { definePanqueueConfig } from "@panqueue/config";
import { defineWorker } from "./define_worker.ts";
import { _internals } from "./redis_connection.ts";
import { WorkerPool } from "./worker_pool.ts";
import { createFakeClient, type FakeClient } from "./internal/_test_utils.ts";

type TestQueues = {
  emails: { to: string; subject: string };
  thumbnails: { url: string; width: number };
};

const pq = definePanqueueConfig<TestQueues>({
  redis: "redis://localhost:6379",
  queues: {
    emails: {},
    thumbnails: {},
  },
});

/** Stubs `_internals.createClient` to return fakes in order. */
function stubCreateClients(...fakeClients: FakeClient[]) {
  let i = 0;
  return stub(
    _internals,
    "createClient",
    // deno-lint-ignore no-explicit-any
    (() => fakeClients[i++] ?? fakeClients[fakeClients.length - 1]) as any,
  );
}

// ── Construction ──────────────────────────────────────────────────────

Deno.test("WorkerPool — throws when workers is empty", () => {
  expect(() => new WorkerPool(pq, { workers: [] })).toThrow(
    "at least one worker definition",
  );
});

Deno.test("WorkerPool — rejects non-defineWorker objects", () => {
  expect(() =>
    new WorkerPool(pq, {
      // deno-lint-ignore no-explicit-any
      workers: [{ queueId: "emails", processor: async () => {} } as any],
    })
  ).toThrow("defineWorker");
});

Deno.test("WorkerPool — rejects duplicate queue IDs", () => {
  const a = defineWorker(pq, "emails", async () => {});
  const b = defineWorker(pq, "emails", async () => {});
  expect(() => new WorkerPool(pq, { workers: [a, b] })).toThrow("Duplicate");
});

Deno.test("WorkerPool — size reflects registered workers", () => {
  const pool = new WorkerPool(pq, {
    workers: [
      defineWorker(pq, "emails", async () => {}),
      defineWorker(pq, "thumbnails", async () => {}),
    ],
  });
  expect(pool.size).toBe(2);
});

// ── Connection sharing (the load-bearing property of this design) ─────

Deno.test("WorkerPool — opens exactly one command + one subscriber connection regardless of N workers", async () => {
  const cmdClient = createFakeClient();
  const subClient = createFakeClient();
  const restore = stubCreateClients(cmdClient, subClient);

  try {
    const pool = new WorkerPool(pq, {
      workers: [
        defineWorker(pq, "emails", async () => {}),
        defineWorker(pq, "thumbnails", async () => {}),
      ],
    });
    await pool.start();

    expect(restore.calls.length).toBe(2);

    // Subscriber subscribed to both queues' notify channels.
    const subscribeCalls = (subClient.subscribe as Spy).calls;
    const channels = subscribeCalls.map((c) => c.args[0]);
    expect(channels).toContain("{q:emails}:notify");
    expect(channels).toContain("{q:thumbnails}:notify");

    await pool.shutdown();
  } finally {
    restore.restore();
  }
});

Deno.test("WorkerPool — uses options.connection override over config.redis", async () => {
  const cmdClient = createFakeClient();
  const subClient = createFakeClient();

  const seen: unknown[] = [];
  const restore = stub(
    _internals,
    "createClient",
    // deno-lint-ignore no-explicit-any
    ((opts: unknown) => {
      seen.push(opts);
      return seen.length === 1 ? cmdClient : subClient;
    }) as any,
  );

  try {
    const pool = new WorkerPool(pq, {
      workers: [defineWorker(pq, "emails", async () => {})],
      connection: { host: "override-host", port: 9999 },
    });
    await pool.start();

    // First createClient call (command client) was built with override host/port.
    expect(seen[0]).toMatchObject({
      socket: { host: "override-host", port: 9999 },
    });

    await pool.shutdown();
  } finally {
    restore.restore();
  }
});

// ── Lifecycle ─────────────────────────────────────────────────────────

Deno.test("WorkerPool — start() then start() returns the same in-flight promise", async () => {
  const cmdClient = createFakeClient();
  const subClient = createFakeClient();
  const restore = stubCreateClients(cmdClient, subClient);

  try {
    const pool = new WorkerPool(pq, {
      workers: [defineWorker(pq, "emails", async () => {})],
    });

    await Promise.all([pool.start(), pool.start()]);

    // Only one set of clients created.
    expect(restore.calls.length).toBe(2);

    await pool.shutdown();
  } finally {
    restore.restore();
  }
});

Deno.test("WorkerPool — single-shot: start() after shutdown rejects", async () => {
  const cmdClient = createFakeClient();
  const subClient = createFakeClient();
  const restore = stubCreateClients(cmdClient, subClient);

  try {
    const pool = new WorkerPool(pq, {
      workers: [defineWorker(pq, "emails", async () => {})],
    });
    await pool.start();
    await pool.shutdown();

    await expect(pool.start()).rejects.toThrow();
  } finally {
    restore.restore();
  }
});

Deno.test("WorkerPool — shutdown() before start returns clean result and is idempotent", async () => {
  const pool = new WorkerPool(pq, {
    workers: [defineWorker(pq, "emails", async () => {})],
  });

  const r1 = await pool.shutdown();
  const r2 = await pool.shutdown();

  expect(r1).toEqual({
    mode: "force",
    timedOut: false,
    unfinishedJobs: 0,
    requeued: 0,
  });
  // Cached — same value.
  expect(r2).toEqual(r1);
});

Deno.test("WorkerPool — Symbol.asyncDispose calls shutdown", async () => {
  const cmdClient = createFakeClient();
  const subClient = createFakeClient();
  const restore = stubCreateClients(cmdClient, subClient);

  try {
    const pool = new WorkerPool(pq, {
      workers: [defineWorker(pq, "emails", async () => {})],
    });
    await pool.start();
    await pool[Symbol.asyncDispose]();

    expect((cmdClient.disconnect as Spy).calls.length).toBe(1);
  } finally {
    restore.restore();
  }
});

// ── Failure during start ──────────────────────────────────────────────

Deno.test("WorkerPool — partial start failure unwinds connections and throws", async () => {
  const cmdClient = createFakeClient();
  // Subscriber's subscribe throws on the second channel.
  const subClient = createFakeClient();
  let subscribeCount = 0;
  (subClient.subscribe as Spy) = spy(
    (_channel: string | string[], _cb: () => void) => {
      subscribeCount++;
      if (subscribeCount === 2) {
        return Promise.reject(new Error("subscribe failed"));
      }
      return Promise.resolve();
    },
  );

  const restore = stubCreateClients(cmdClient, subClient);

  try {
    const pool = new WorkerPool(pq, {
      workers: [
        defineWorker(pq, "emails", async () => {}),
        defineWorker(pq, "thumbnails", async () => {}),
      ],
    });

    await expect(pool.start()).rejects.toThrow("subscribe failed");

    expect((cmdClient.disconnect as Spy).calls.length).toBe(1);
    expect((subClient.disconnect as Spy).calls.length).toBe(1);

    // Pool is finalized; cannot be restarted.
    await expect(pool.start()).rejects.toThrow();
  } finally {
    restore.restore();
  }
});

// ── Force shutdown across multiple queues ─────────────────────────────

Deno.test("WorkerPool — force shutdown aggregates requeued counts across queues", async () => {
  const job = (q: string, id: string) =>
    JSON.stringify({
      id,
      queueId: q,
      data: { to: "a@b.com", subject: "Hi" },
      status: "active",
      runs: 1,
      failures: 0,
      stalls: 0,
      maxRetries: 0,
      maxStalls: 5,
      createdAt: Date.now(),
      lastStartedAt: Date.now(),
      lockToken: `${id}-tok`,
    });

  let claims = 0;
  const cmdClient = createFakeClient({
    evalFn: () => {
      claims++;
      if (claims === 1) return Promise.resolve(job("emails", "e1"));
      if (claims === 2) return Promise.resolve(job("thumbnails", "t1"));
      return Promise.resolve(null);
    },
  });
  (cmdClient.requeueActive as Spy) = spy(() =>
    Promise.resolve("waiting" as const)
  );
  (cmdClient.complete as Spy) = spy(() => Promise.resolve("stale"));
  const subClient = createFakeClient();
  const restore = stubCreateClients(cmdClient, subClient);

  const { promise: bothStarted, resolve: onBothStarted } = Promise
    .withResolvers<void>();
  const { promise: release, resolve: doRelease } = Promise.withResolvers<
    void
  >();

  let started = 0;
  const make = (q: "emails" | "thumbnails") =>
    defineWorker(pq, q, async () => {
      started++;
      if (started === 2) onBothStarted();
      await release;
    }, { pollInterval: 50 });

  try {
    const pool = new WorkerPool(pq, {
      workers: [make("emails"), make("thumbnails")],
    });
    await pool.start();
    await bothStarted;

    const result = await pool.shutdown();
    expect(result.mode).toBe("force");
    expect(result.unfinishedJobs).toBe(2);
    expect(result.requeued).toBe(2);

    doRelease();
    await new Promise((r) => setTimeout(r, 20));
  } finally {
    restore.restore();
  }
});

Deno.test("WorkerPool — drain timeout falls through to force-requeue", async () => {
  const job = JSON.stringify({
    id: "stuck",
    queueId: "emails",
    data: { to: "a@b.com", subject: "Hi" },
    status: "active",
    runs: 1,
    failures: 0,
    stalls: 0,
    maxRetries: 0,
    maxStalls: 5,
    createdAt: Date.now(),
    lastStartedAt: Date.now(),
    lockToken: "stuck-tok",
  });

  let claims = 0;
  const cmdClient = createFakeClient({
    evalFn: () => {
      claims++;
      if (claims === 1) return Promise.resolve(job);
      return Promise.resolve(null);
    },
  });
  (cmdClient.requeueActive as Spy) = spy(() =>
    Promise.resolve("waiting" as const)
  );
  (cmdClient.complete as Spy) = spy(() => Promise.resolve("stale"));
  const subClient = createFakeClient();
  const restore = stubCreateClients(cmdClient, subClient);

  const { promise: started, resolve: onStarted } = Promise.withResolvers<
    void
  >();
  const { promise: release, resolve: doRelease } = Promise.withResolvers<
    void
  >();

  try {
    const pool = new WorkerPool(pq, {
      workers: [
        defineWorker(pq, "emails", async () => {
          onStarted();
          await release;
        }, { pollInterval: 50 }),
      ],
    });
    await pool.start();
    await started;

    const result = await pool.shutdown({ drain: true, timeout: 30 });
    expect(result.mode).toBe("drain");
    expect(result.timedOut).toBe(true);
    expect(result.unfinishedJobs).toBe(1);
    expect(result.requeued).toBe(1);

    const requeueCalls = (cmdClient.requeueActive as Spy).calls;
    expect(requeueCalls.length).toBe(1);
    // requeueActive(activeKey, waitingKey, jobsKey, notifyKey, corruptKey, corruptDataKey, jobId, lockToken, reason)
    expect(requeueCalls[0].args[8]).toBe("shutdown-timeout");

    doRelease();
    await new Promise((r) => setTimeout(r, 20));
  } finally {
    restore.restore();
  }
});

Deno.test("WorkerPool — drain without timeout waits for in-flight to finish", async () => {
  const job = JSON.stringify({
    id: "drain-1",
    queueId: "emails",
    data: { to: "a@b.com", subject: "Hi" },
    status: "active",
    runs: 1,
    failures: 0,
    stalls: 0,
    maxRetries: 0,
    maxStalls: 5,
    createdAt: Date.now(),
    lastStartedAt: Date.now(),
    lockToken: "drain-tok",
  });

  let claims = 0;
  const cmdClient = createFakeClient({
    evalFn: () => {
      claims++;
      if (claims === 1) return Promise.resolve(job);
      return Promise.resolve(null);
    },
  });
  (cmdClient.complete as Spy) = spy(() => Promise.resolve("completed"));
  const subClient = createFakeClient();
  const restore = stubCreateClients(cmdClient, subClient);

  const { promise: started, resolve: onStarted } = Promise.withResolvers<
    void
  >();
  const { promise: release, resolve: doRelease } = Promise.withResolvers<
    void
  >();

  try {
    const pool = new WorkerPool(pq, {
      workers: [
        defineWorker(pq, "emails", async () => {
          onStarted();
          await release;
        }, { pollInterval: 50 }),
      ],
    });
    await pool.start();
    await started;

    const shutdownPromise = pool.shutdown({ drain: true });
    await new Promise((r) => setTimeout(r, 20));
    doRelease();
    const result = await shutdownPromise;

    expect(result.mode).toBe("drain");
    expect(result.timedOut).toBe(false);
    expect(result.unfinishedJobs).toBe(0);
    expect(result.requeued).toBe(0);
    expect((cmdClient.requeueActive as Spy).calls.length).toBe(0);
  } finally {
    restore.restore();
  }
});
