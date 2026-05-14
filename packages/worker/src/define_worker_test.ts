import { expect } from "jsr:@std/expect";
import { definePanqueueConfig } from "@panqueue/config";
import {
  defineWorker,
  isWorkerDefinition,
  WORKER_DEFINITION_BRAND,
} from "./define_worker.ts";

type Queues = {
  emails: { to: string; subject: string };
  thumbnails: { url: string; width: number };
};

const pq = definePanqueueConfig<Queues>({
  redis: { host: "localhost", port: 6379 },
  queues: {
    emails: {},
    thumbnails: {},
  },
});

Deno.test("defineWorker — captures queueId, processor, and options", () => {
  const fn = async () => {};
  const def = defineWorker(pq, "emails", fn, { concurrency: 5 });

  expect(def.queueId).toBe("emails");
  expect(def.processor).toBe(fn);
  expect(def.options.concurrency).toBe(5);
});

Deno.test("defineWorker — defaults options to {} when omitted", () => {
  const def = defineWorker(pq, "emails", async () => {});
  expect(def.options).toEqual({});
});

Deno.test("defineWorker — result is branded and frozen", () => {
  const def = defineWorker(pq, "emails", async () => {});
  expect(def[WORKER_DEFINITION_BRAND]).toBe(true);
  expect(Object.isFrozen(def)).toBe(true);
});

Deno.test("isWorkerDefinition — narrows valid definitions", () => {
  const def = defineWorker(pq, "emails", async () => {});
  expect(isWorkerDefinition(def)).toBe(true);
});

Deno.test("isWorkerDefinition — rejects plain objects and primitives", () => {
  expect(isWorkerDefinition(null)).toBe(false);
  expect(isWorkerDefinition(undefined)).toBe(false);
  expect(isWorkerDefinition("string")).toBe(false);
  expect(isWorkerDefinition({ queueId: "emails" })).toBe(false);
  expect(isWorkerDefinition({ [WORKER_DEFINITION_BRAND]: false })).toBe(false);
});
