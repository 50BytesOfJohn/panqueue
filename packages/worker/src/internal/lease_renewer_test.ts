import { expect } from "jsr:@std/expect";
import { type Spy, spy } from "jsr:@std/testing/mock";
import type { ExtendLockResult } from "../scheduler/base.ts";
import { createErrorCapture } from "./_test_utils.ts";
import { LeaseRenewer } from "./lease_renewer.ts";

const tick = (ms: number) => new Promise((r) => setTimeout(r, ms));

type ExtendLockSpy = Spy<
  unknown,
  [string, number, string],
  Promise<ExtendLockResult>
>;

const extendSpy = (
  result: ExtendLockResult | (() => Promise<ExtendLockResult>),
): ExtendLockSpy =>
  spy((_jobId: string, _leaseMs: number, _lockToken: string) =>
    typeof result === "function" ? result() : Promise.resolve(result)
  );

function makeRenewer(
  extendLock: ExtendLockSpy,
  overrides: Partial<{ leaseMs: number; lockRenewMs: number }> = {},
) {
  const { errors, onError } = createErrorCapture();
  const corrupt: { jobId: string; reason: string }[] = [];
  const renewer = new LeaseRenewer({
    scheduler: { extendLock },
    leaseMs: overrides.leaseMs ?? 60,
    lockRenewMs: overrides.lockRenewMs ?? 20,
    onError,
    onJobCorrupt: (jobId, reason) => corrupt.push({ jobId, reason }),
  });
  return { renewer, errors, corrupt };
}

Deno.test("LeaseRenewer — no lockToken disables renewal", async () => {
  const extendLock = extendSpy("extended");
  const { renewer } = makeRenewer(extendLock);

  const handle = renewer.start("job-1", "");
  await tick(60);
  handle.stop();

  expect(extendLock.calls.length).toBe(0);
});

Deno.test("LeaseRenewer — lockRenewMs <= 0 disables renewal", async () => {
  const extendLock = extendSpy("extended");
  const { renewer } = makeRenewer(extendLock, { lockRenewMs: 0 });

  const handle = renewer.start("job-1", "tok");
  await tick(60);
  handle.stop();

  expect(extendLock.calls.length).toBe(0);
});

Deno.test("LeaseRenewer — renews periodically until stopped", async () => {
  const extendLock = extendSpy("extended");
  const { renewer } = makeRenewer(extendLock, { lockRenewMs: 20 });

  const handle = renewer.start("job-1", "tok");
  await tick(70);
  handle.stop();
  const afterStop = extendLock.calls.length;
  expect(afterStop).toBeGreaterThanOrEqual(2);

  await tick(50);
  expect(extendLock.calls.length).toBe(afterStop);
  // extendLock(jobId, leaseMs, lockToken)
  expect(extendLock.calls[0].args).toEqual(["job-1", 60, "tok"]);
});

Deno.test("LeaseRenewer — lost lease emits lease-lost and stops renewing", async () => {
  const extendLock = extendSpy("stale");
  const { renewer, errors } = makeRenewer(extendLock, { lockRenewMs: 20 });

  const handle = renewer.start("lost", "tok");
  await tick(80);
  handle.stop();

  expect(extendLock.calls.length).toBe(1);
  const leaseLost = errors.filter((e) => e.context === "lease-lost:lost");
  expect(leaseLost.length).toBe(1);
});

Deno.test("LeaseRenewer — corrupt result emits onJobCorrupt and lease-lost", async () => {
  const extendLock = extendSpy("corrupt");
  const { renewer, errors, corrupt } = makeRenewer(extendLock, {
    lockRenewMs: 20,
  });

  const handle = renewer.start("bad", "tok");
  await tick(50);
  handle.stop();

  expect(corrupt).toEqual([{ jobId: "bad", reason: "invalid-json" }]);
  expect(errors.filter((e) => e.context === "lease-lost:bad").length).toBe(1);
});

Deno.test("LeaseRenewer — extend rejection surfaces and keeps renewing", async () => {
  let n = 0;
  const extendLock = extendSpy(() => {
    n++;
    if (n === 1) return Promise.reject(new Error("redis down"));
    return Promise.resolve("extended");
  });
  const { renewer, errors } = makeRenewer(extendLock, { lockRenewMs: 20 });

  const handle = renewer.start("job-1", "tok");
  await tick(70);
  handle.stop();

  expect(errors.filter((e) => e.context === "extend:job-1").length).toBe(1);
  expect(extendLock.calls.length).toBeGreaterThanOrEqual(2);
});
