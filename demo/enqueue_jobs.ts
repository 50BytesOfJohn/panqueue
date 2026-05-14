import { QueueClient } from "@panqueue/client";
import { withInspector } from "./_inspect.ts";

type DemoQueues = {
  emails: { to: string; subject: string; body: string };
  thumbnails: { url: string; width: number };
};

const CONNECTION = { host: "localhost", port: 6399 };

const client = new QueueClient<DemoQueues>({ connection: CONNECTION });

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

await withInspector(CONNECTION, async (redis) => {
  const emailJobs = await redis.lRange("{q:emails}:waiting", 0, -1);
  console.log(`emails:waiting → [${emailJobs.join(", ")}]`);

  const thumbJobs = await redis.lRange("{q:thumbnails}:waiting", 0, -1);
  console.log(`thumbnails:waiting → [${thumbJobs.join(", ")}]`);

  const jobData = await redis.hGet("{q:emails}:jobs", job1);
  if (jobData) {
    console.log(`\nSample job data for ${job1}:`);
    console.log(JSON.parse(jobData));
  }
});

await client.disconnect();
console.log("\nDone!");
