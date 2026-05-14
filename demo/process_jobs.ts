import { definePanqueueConfig } from "@panqueue/config";
import { defineWorker, WorkerPool } from "@panqueue/worker";

type DemoQueues = {
  emails: { to: string; subject: string; body: string };
  thumbnails: { url: string; width: number };
};

const pq = definePanqueueConfig<DemoQueues>({
  redis: { host: "localhost", port: 6399 },
  queues: {
    emails: { mode: "global" },
    thumbnails: { mode: "global" },
  },
});

const emailsWorker = defineWorker(pq, "emails", async (job) => {
  console.log(
    `[${
      new Date().toISOString()
    }] Processing email to ${job.data.to}: "${job.data.subject}"`,
  );
  console.log(`  Simulating work for 5 seconds...`);
  await new Promise((resolve) => setTimeout(resolve, 5000));
  console.log(`[${new Date().toISOString()}] Done: ${job.data.to}`);
});

const pool = new WorkerPool(pq, { workers: [emailsWorker] });

console.log("Starting email worker (concurrency: 1)...\n");
await pool.start();
console.log("Worker running. Waiting for jobs... (Ctrl+C to stop)\n");

Deno.addSignalListener("SIGINT", async () => {
  console.log("\nShutting down...");
  await pool.shutdown();
  console.log("Done!");
  Deno.exit(0);
});
