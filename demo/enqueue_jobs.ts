import { QueueClient } from "@panqueue/client";

type DemoQueues = {
  emails: { to: string; subject: string; body: string };
  thumbnails: { url: string; width: number };
};

const client = new QueueClient<DemoQueues>({
  connection: { host: "localhost", port: 6399 },
});

const job1 = await client.enqueue("emails", {
  to: "alice@example.com",
  subject: "Welcome!",
  body: "Thanks for signing up.",
});
console.log(`Enqueued email job: ${job1}`);

const job2 = await client.enqueue("emails", {
  to: "bob@example.com",
  subject: "Password Reset",
  body: "Click here to reset your password.",
});
console.log(`Enqueued email job: ${job2}`);

const job3 = await client.enqueue("thumbnails", {
  url: "https://example.com/photo.jpg",
  width: 200,
});
console.log(`Enqueued thumbnail job: ${job3}`);

console.log("\nAll 3 jobs enqueued. Verifying in Redis...\n");

// Read back the jobs from Redis to verify
const redis = client.redis.client;

const emailJobs = await redis.lRange("{q:emails}:waiting", 0, -1);
console.log(`emails:waiting → [${emailJobs.join(", ")}]`);

const thumbJobs = await redis.lRange("{q:thumbnails}:waiting", 0, -1);
console.log(`thumbnails:waiting → [${thumbJobs.join(", ")}]`);

// Show one job's full data
const jobData = await redis.hGet("{q:emails}:jobs", job1);
if (jobData) {
  console.log(`\nSample job data for ${job1}:`);
  console.log(JSON.parse(jobData));
}

await client.disconnect();
console.log("\nDone!");
