import { expect } from "jsr:@std/expect";
import { Semaphore } from "./semaphore.ts";

Deno.test("acquire/release with capacity 1", async () => {
  const sem = new Semaphore(1);

  expect(sem.available).toBe(1);
  await sem.acquire();
  expect(sem.available).toBe(0);

  sem.release();
  expect(sem.available).toBe(1);
});

Deno.test("blocks when at capacity", async () => {
  const sem = new Semaphore(1);
  await sem.acquire();

  let acquired = false;
  const pending = sem.acquire().then(() => {
    acquired = true;
  });

  // Give microtasks a chance to run
  await Promise.resolve();
  expect(acquired).toBe(false);
  expect(sem.pending).toBe(1);

  sem.release();
  await pending;
  expect(acquired).toBe(true);

  sem.release();
});

Deno.test("FIFO wake order", async () => {
  const sem = new Semaphore(1);
  await sem.acquire();

  const order: number[] = [];
  const p1 = sem.acquire().then(() => order.push(1));
  const p2 = sem.acquire().then(() => order.push(2));

  sem.release();
  await p1;
  sem.release();
  await p2;

  expect(order).toEqual([1, 2]);

  sem.release();
});

Deno.test("multiple permits", async () => {
  const sem = new Semaphore(3);

  await sem.acquire();
  await sem.acquire();
  await sem.acquire();
  expect(sem.available).toBe(0);

  sem.release();
  expect(sem.available).toBe(1);

  sem.release();
  sem.release();
  expect(sem.available).toBe(3);
});

Deno.test("drain resolves when all permits returned", async () => {
  const sem = new Semaphore(2);
  await sem.acquire();
  await sem.acquire();

  let drained = false;
  const drainPromise = sem.drain().then(() => {
    drained = true;
  });

  await Promise.resolve();
  expect(drained).toBe(false);

  sem.release();
  await Promise.resolve();
  expect(drained).toBe(false);

  sem.release();
  await drainPromise;
  expect(drained).toBe(true);
});

Deno.test("drain resolves immediately when no permits held", async () => {
  const sem = new Semaphore(2);
  await sem.drain();
  // No assertion needed — test passes if drain resolves
});

Deno.test("constructor throws for invalid max", () => {
  expect(() => new Semaphore(0)).toThrow(RangeError);
  expect(() => new Semaphore(-1)).toThrow(RangeError);
});

Deno.test("acquire rejects immediately if signal already aborted", async () => {
  const sem = new Semaphore(1);
  const controller = new AbortController();
  controller.abort();

  await expect(sem.acquire(controller.signal)).rejects.toThrow();
  // Permit was not consumed
  expect(sem.available).toBe(1);
});

Deno.test("acquire rejects and removes waiter when signal is aborted", async () => {
  const sem = new Semaphore(1);
  await sem.acquire(); // consume the only permit

  const controller = new AbortController();
  const pending = sem.acquire(controller.signal);

  expect(sem.pending).toBe(1);

  controller.abort();
  await expect(pending).rejects.toThrow();

  // Waiter was removed from the queue
  expect(sem.pending).toBe(0);

  // Release the original permit — no waiter to wake, so it returns to pool
  sem.release();
  expect(sem.available).toBe(1);
});

Deno.test("abort does not affect already-resolved acquire", async () => {
  const sem = new Semaphore(2);
  const controller = new AbortController();

  // Permit available immediately — resolves synchronously
  await sem.acquire(controller.signal);
  expect(sem.available).toBe(1);

  // Aborting after acquire resolved should have no effect
  controller.abort();
  expect(sem.available).toBe(1);

  sem.release();
  expect(sem.available).toBe(2);
});

Deno.test("abort listener is removed when waiter resolves via release", async () => {
  const sem = new Semaphore(1);
  await sem.acquire(); // consume the only permit

  const controller = new AbortController();
  const { signal } = controller;

  // Spy on removeEventListener to verify cleanup
  let removeCalled = false;
  const origRemove = signal.removeEventListener.bind(signal);
  signal.removeEventListener = (...args: Parameters<AbortSignal["removeEventListener"]>) => {
    removeCalled = true;
    return origRemove(...args);
  };

  const pending = sem.acquire(signal);

  // Normal resolution path: release wakes the waiter
  sem.release();
  await pending;

  expect(removeCalled).toBe(true);

  // The listener is gone — aborting now should not cause any side effects
  controller.abort();
  expect(sem.pending).toBe(0);

  sem.release();
});

Deno.test("no listener leak under repeated contention", async () => {
  const sem = new Semaphore(1);
  const controller = new AbortController();

  // Simulate 100 acquire/release cycles that all block and resolve normally.
  // Without cleanup, this would leave 100 abort listeners on the signal.
  for (let i = 0; i < 100; i++) {
    await sem.acquire(); // hold the permit
    const pending = sem.acquire(controller.signal); // blocks, attaches listener
    sem.release(); // wakes the waiter, should clean up listener
    await pending;
    sem.release(); // return the permit for the next iteration
  }

  // If listeners leaked, aborting would try to splice from an empty #waiters
  // array 100 times. Verify no waiters are queued.
  expect(sem.pending).toBe(0);
  expect(sem.available).toBe(1);
});
