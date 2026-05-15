import { expect } from "jsr:@std/expect";
import { type Spy, spy } from "jsr:@std/testing/mock";
import { createErrorCapture } from "./_test_utils.ts";
import { StalledRecoverySweep } from "./stalled_recovery_sweep.ts";

const tick = (ms: number) => new Promise((r) => setTimeout(r, ms));

type RecoverSpy = Spy<unknown, [number], Promise<string[]>>;

const recoverSpy = (
  result: string[] | (() => Promise<string[]>),
): RecoverSpy =>
  spy((_batchSize: number) =>
    typeof result === "function" ? result() : Promise.resolve(result)
  );

function makeSweep(
  recover: RecoverSpy,
  overrides: Partial<
    { intervalMs: number; batchSize: number; isActive: () => boolean }
  > = {},
) {
  const { errors, onError } = createErrorCapture();
  const recoveredBatches: string[][] = [];
  const corrupt: { jobId: string; reason: string }[] = [];
  const sweep = new StalledRecoverySweep({
    scheduler: { recover },
    intervalMs: overrides.intervalMs ?? 30,
    batchSize: overrides.batchSize ?? 50,
    isActive: overrides.isActive ?? (() => true),
    onJobRecovered: (ids) => recoveredBatches.push(ids),
    onError,
    onJobCorrupt: (jobId, reason) => corrupt.push({ jobId, reason }),
  });
  return { sweep, errors, recoveredBatches, corrupt };
}

Deno.test("StalledRecoverySweep — intervalMs <= 0 never sweeps", async () => {
  const recover = recoverSpy([]);
  const { sweep } = makeSweep(recover, { intervalMs: 0 });

  sweep.start();
  await tick(50);
  sweep.stop();

  expect(recover.calls.length).toBe(0);
});

Deno.test("StalledRecoverySweep — periodic sweep emits onJobRecovered", async () => {
  const recover = recoverSpy(["r-1", "r-2"]);
  const { sweep, recoveredBatches } = makeSweep(recover, { intervalMs: 25 });

  sweep.start();
  await tick(70);
  sweep.stop();

  expect(recover.calls.length).toBeGreaterThanOrEqual(1);
  expect(recover.calls[0].args).toEqual([50]);
  expect(recoveredBatches[0]).toEqual(["r-1", "r-2"]);
});

Deno.test("StalledRecoverySweep — stop() halts further sweeps", async () => {
  const recover = recoverSpy(["r-1"]);
  const { sweep } = makeSweep(recover, { intervalMs: 20 });

  sweep.start();
  await tick(50);
  sweep.stop();
  const after = recover.calls.length;
  await tick(50);

  expect(recover.calls.length).toBe(after);
});

Deno.test("StalledRecoverySweep — corrupt ids are quarantined and filtered", async () => {
  const recover = recoverSpy(["r-1", "corrupt:bad-1", "r-2"]);
  const { sweep, recoveredBatches, corrupt } = makeSweep(recover);

  await sweep.run();

  expect(corrupt).toEqual([{ jobId: "bad-1", reason: "invalid-json" }]);
  expect(recoveredBatches).toEqual([["r-1", "r-2"]]);
});

Deno.test("StalledRecoverySweep — only-corrupt batch skips onJobRecovered", async () => {
  const recover = recoverSpy(["corrupt:bad-1"]);
  const { sweep, recoveredBatches, corrupt } = makeSweep(recover);

  await sweep.run();

  expect(corrupt).toEqual([{ jobId: "bad-1", reason: "invalid-json" }]);
  expect(recoveredBatches).toEqual([]);
});

Deno.test("StalledRecoverySweep — inactive runner skips recover", async () => {
  const recover = recoverSpy(["r-1"]);
  const { sweep, recoveredBatches } = makeSweep(recover, {
    isActive: () => false,
  });

  await sweep.run();

  expect(recover.calls.length).toBe(0);
  expect(recoveredBatches).toEqual([]);
});

Deno.test("StalledRecoverySweep — recover rejection surfaces via onError", async () => {
  const recover = recoverSpy(() => Promise.reject(new Error("redis down")));
  const { sweep, errors } = makeSweep(recover);

  await sweep.run();

  expect(errors.filter((e) => e.context === "recover").length).toBe(1);
});
