import { assertEquals } from "jsr:@std/assert";
import { definePanqueueConfig } from "./define_config.ts";

type TestQueues = {
  email: { to: string; subject: string };
  image: { url: string; width: number };
};

Deno.test("definePanqueueConfig returns the config unchanged", () => {
  const input = {
    redis: { url: "redis://localhost:6379" },
    queues: {
      email: { mode: "global" as const },
      image: { mode: "global" as const },
    },
  };

  const result = definePanqueueConfig<TestQueues>(input);

  assertEquals(result, input);
  assertEquals(result === input, true);
});

Deno.test("definePanqueueConfig accepts ConnectionOptions string", () => {
  const result = definePanqueueConfig<TestQueues>({
    redis: "redis://localhost:6379",
    queues: {
      email: { mode: "global" },
      image: { mode: "global" },
    },
  });

  assertEquals(result.redis, "redis://localhost:6379");
});

Deno.test("definePanqueueConfig accepts ConnectionOptions object", () => {
  const result = definePanqueueConfig<TestQueues>({
    redis: { host: "localhost", port: 6379 },
    queues: {
      email: { mode: "global" },
      image: { mode: "global" },
    },
  });

  assertEquals(result.redis, { host: "localhost", port: 6379 });
});
