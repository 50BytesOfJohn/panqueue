import { Worker } from "@panqueue/worker";

type DemoQueues = {
  emails: { to: string; subject: string; body: string };
  thumbnails: { url: string; width: number };
};

const worker = new Worker<DemoQueues>("emails", async (job) => {
  console.log(`[${new Date().toISOString()}] Processing email to ${job.data.to}: "${job.data.subject}"`);
  console.log(`  Simulating work for 5 seconds...`);
  await new Promise((resolve) => setTimeout(resolve, 5000));
  console.log(`[${new Date().toISOString()}] Done: ${job.data.to}`);
}, {
  connection: { host: "localhost", port: 6399 },
});

console.log("Starting email worker (concurrency: 1)...\n");
await worker.start();
console.log("Worker running. Waiting for jobs... (Ctrl+C to stop)\n");

Deno.addSignalListener("SIGINT", async () => {
  console.log("\nShutting down...");
  await worker.shutdown();
  console.log("Done!");
  Deno.exit(0);
});
