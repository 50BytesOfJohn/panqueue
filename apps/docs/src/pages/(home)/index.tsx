import { Callout } from "fumadocs-ui/components/callout";
import { Cards, Card } from "fumadocs-ui/components/card";
import { DynamicCodeBlock } from "fumadocs-ui/components/dynamic-codeblock";
import { Steps, Step } from "fumadocs-ui/components/steps";
import { ArrowRight, ShieldCheck, Repeat, Code2, Gauge } from "lucide-react";
import { Link } from "waku";

import { CopyButton } from "@/components/ui/copy-button";

const INSTALL_CMD = "pnpm add @panqueue/config @panqueue/client @panqueue/worker";

const CONFIG_CODE = `import { definePanqueueConfig } from "@panqueue/config";

type Queues = {
  email: { to: string; subject: string };
  thumbnail: { url: string };
};

export const pq = definePanqueueConfig<Queues>({
  redis: { url: "redis://localhost:6379" },
  queues: {
    email: {},
    thumbnail: {},
  },
});`;

const ENQUEUE_CODE = `import { createQueueClient } from "@panqueue/client";
import { pq } from "./panqueue.config.js";

const client = createQueueClient(pq);

await client.enqueue("email", {
  to: "user@example.com",
  subject: "Welcome!",
});`;

const WORKER_CODE = `import { defineWorker, WorkerPool } from "@panqueue/worker";
import { pq } from "./panqueue.config.js";

const emailWorker = defineWorker(pq, "email", async (job) => {
  await sendEmail(job.data);
}, { concurrency: 5 });

const pool = new WorkerPool(pq, { workers: [emailWorker] });
await pool.start();`;

function GithubIcon({ size = 16 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <path d="M12 0C5.37 0 0 5.37 0 12c0 5.31 3.435 9.795 8.205 11.385.6.105.825-.255.825-.57 0-.285-.015-1.23-.015-2.235-3.015.555-3.795-.735-4.035-1.41-.135-.345-.72-1.41-1.23-1.695-.42-.225-1.02-.78-.015-.795.945-.015 1.62.87 1.845 1.23 1.08 1.815 2.805 1.305 3.495.99.105-.78.42-1.305.765-1.605-2.67-.3-5.46-1.335-5.46-5.925 0-1.305.465-2.385 1.23-3.225-.12-.3-.54-1.53.12-3.18 0 0 1.005-.315 3.3 1.23.96-.27 1.98-.405 3-.405s2.04.135 3 .405c2.295-1.56 3.3-1.23 3.3-1.23.66 1.65.24 2.88.12 3.18.765.84 1.23 1.905 1.23 3.225 0 4.605-2.805 5.625-5.475 5.925.435.375.81 1.095.81 2.22 0 1.605-.015 2.895-.015 3.3 0 .315.225.69.825.57A12.02 12.02 0 0024 12c0-6.63-5.37-12-12-12z" />
    </svg>
  );
}

export default function Home() {
  return (
    <div className="flex flex-col">
      {/* ── Hero ─────────────────────────────────────────── */}
      <section className="relative flex min-h-[calc(100vh-4rem)] flex-col items-center justify-center overflow-hidden px-6 py-28 text-center">
        <div
          className="pointer-events-none absolute inset-0"
          style={{
            background:
              "radial-gradient(ellipse 55% 35% at 50% 28%, hsla(38,80%,50%,0.09) 0%, transparent 70%)",
          }}
        />

        <div className="relative mb-8">
          <div
            className="absolute inset-0 rounded-full opacity-50 blur-3xl"
            style={{ background: "hsla(38,80%,50%,0.2)", transform: "scale(1.6)" }}
          />
          <img
            src="/logo.png"
            alt="panqueue mascot"
            width={96}
            height={96}
            className="relative drop-shadow-xl"
          />
        </div>

        <div className="mb-6 inline-flex items-center gap-2 rounded-full border border-fd-border bg-fd-card px-3 py-1 text-xs text-fd-muted-foreground">
          <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-fd-primary" />
          Pre-release · Node · Bun · Deno
        </div>

        <h1 className="mb-4 text-6xl font-extrabold tracking-tight text-fd-foreground sm:text-7xl lg:text-8xl">
          pan<span className="text-fd-primary">queue</span>
        </h1>

        <p className="mb-2 text-lg font-medium text-fd-muted-foreground sm:text-xl">
          A fast, ergonomic job queue for JavaScript and TypeScript.
        </p>
        <p className="mb-10 max-w-xl text-sm leading-relaxed text-fd-muted-foreground/70">
          Backed by Redis. Typed end to end. One small API you can learn in minutes.
        </p>

        <div className="mb-8 w-full max-w-xl">
          <div className="flex items-center gap-3 rounded-xl border border-fd-border bg-fd-card px-4 py-3 font-mono text-sm">
            <span className="text-fd-primary select-none">$</span>
            <span className="flex-1 truncate text-left text-fd-foreground/80">{INSTALL_CMD}</span>
            <CopyButton text={INSTALL_CMD} />
          </div>
        </div>

        <div className="flex flex-wrap items-center justify-center gap-3">
          <Link
            to="/docs"
            className="inline-flex items-center gap-2 rounded-lg bg-fd-primary px-5 py-2.5 text-sm font-semibold text-fd-primary-foreground transition-opacity hover:opacity-90 active:scale-95"
          >
            Get started
            <ArrowRight size={15} />
          </Link>
          <a
            href="https://github.com/50BytesOfJohn/panqueue"
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-2 rounded-lg border border-fd-border bg-fd-card px-5 py-2.5 text-sm font-semibold text-fd-foreground/80 transition-colors hover:bg-fd-accent hover:text-fd-accent-foreground active:scale-95"
          >
            <GithubIcon size={16} />
            GitHub
          </a>
        </div>
      </section>

      {/* ── Status callout ───────────────────────────────── */}
      <div className="mx-auto w-full max-w-4xl px-6 pb-2">
        <Callout type="warn" title="Pre-release">
          Panqueue is stabilising toward v0.1. The core API is solid but may still change. Follow{" "}
          <a
            href="https://github.com/50BytesOfJohn/panqueue"
            className="underline underline-offset-2"
          >
            the repo
          </a>{" "}
          for updates.
        </Callout>
      </div>

      {/* ── Features ─────────────────────────────────────── */}
      <section className="px-6 py-20">
        <div className="mx-auto max-w-4xl">
          <div className="mb-12 text-center">
            <p className="mb-2 text-xs font-semibold tracking-widest text-fd-primary uppercase">
              Why panqueue
            </p>
            <h2 className="text-3xl font-bold text-fd-foreground sm:text-4xl">
              A queue that gets out of your way
            </h2>
            <p className="mt-3 text-sm text-fd-muted-foreground">
              Focused on the two things a queue library has to nail: speed and developer experience.
            </p>
          </div>

          <Cards>
            <Card
              icon={<Code2 size={18} className="text-fd-primary" />}
              title="Type-safe end to end"
              description="Define your queues once. Get full autocomplete and type checking on every enqueue and every worker handler — no stringly-typed payloads."
            />
            <Card
              icon={<Repeat size={18} className="text-fd-primary" />}
              title="No work lost on crashes"
              description="If a worker dies mid-job, another worker picks the job up automatically. Retries and a bounded dead-letter set are built in."
            />
            <Card
              icon={<Gauge size={18} className="text-fd-primary" />}
              title="Fast and lightweight"
              description="Lean core, no background services, no SDK lock-in. Just your code, Redis, and the queue."
            />
            <Card
              icon={<ShieldCheck size={18} className="text-fd-primary" />}
              title="Clean shutdowns, by default"
              description="Stop your worker and in-flight jobs are handed back to the queue. No stranded work, no manual cleanup."
            />
          </Cards>
        </div>
      </section>

      {/* ── Quick start ───────────────────────────────────── */}
      <section className="border-t border-fd-border px-6 py-20">
        <div className="mx-auto max-w-4xl">
          <div className="mb-12 text-center">
            <p className="mb-2 text-xs font-semibold tracking-widest text-fd-primary uppercase">
              Quick start
            </p>
            <h2 className="text-3xl font-bold text-fd-foreground sm:text-4xl">
              Three files, one queue
            </h2>
            <p className="mt-3 text-sm text-fd-muted-foreground">
              Define your queues, enqueue from anywhere, run workers that process jobs.
            </p>
          </div>

          <Steps>
            <Step>
              <h3 className="mb-3 text-base font-semibold text-fd-foreground">
                Define your queues
              </h3>
              <DynamicCodeBlock
                lang="ts"
                code={CONFIG_CODE}
                codeblock={{ title: "panqueue.config.ts" }}
              />
            </Step>

            <Step>
              <h3 className="mb-3 text-base font-semibold text-fd-foreground">Enqueue jobs</h3>
              <DynamicCodeBlock lang="ts" code={ENQUEUE_CODE} codeblock={{ title: "enqueue.ts" }} />
            </Step>

            <Step>
              <h3 className="mb-3 text-base font-semibold text-fd-foreground">Process jobs</h3>
              <DynamicCodeBlock lang="ts" code={WORKER_CODE} codeblock={{ title: "worker.ts" }} />
            </Step>
          </Steps>
        </div>
      </section>

      {/* ── CTA banner ────────────────────────────────────── */}
      <section className="border-t border-fd-border px-6 py-20">
        <div
          className="mx-auto max-w-4xl overflow-hidden rounded-2xl border border-fd-border p-10 text-center"
          style={{
            background:
              "radial-gradient(ellipse 70% 90% at 50% 0%, hsla(38,80%,50%,0.07) 0%, transparent 70%), var(--color-fd-card)",
          }}
        >
          <h2 className="mb-3 text-2xl font-bold text-fd-foreground sm:text-3xl">
            Ready to start cooking?
          </h2>
          <p className="mb-8 text-sm text-fd-muted-foreground">
            The docs walk through the full API, worker options, and job lifecycle.
          </p>
          <div className="flex flex-wrap items-center justify-center gap-3">
            <Link
              to="/docs"
              className="inline-flex items-center gap-2 rounded-lg bg-fd-primary px-5 py-2.5 text-sm font-semibold text-fd-primary-foreground transition-opacity hover:opacity-90 active:scale-95"
            >
              Read the docs
              <ArrowRight size={15} />
            </Link>
            <a
              href="https://github.com/50BytesOfJohn/panqueue"
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-2 rounded-lg border border-fd-border bg-fd-card px-5 py-2.5 text-sm font-semibold text-fd-foreground/80 transition-colors hover:bg-fd-accent hover:text-fd-accent-foreground active:scale-95"
            >
              <GithubIcon size={16} />
              Star on GitHub
            </a>
          </div>
        </div>
      </section>

      {/* ── Footer ────────────────────────────────────────── */}
      <footer className="border-t border-fd-border px-6 py-6 text-center text-xs text-fd-muted-foreground/60">
        <p>
          MIT License ·{" "}
          <a
            href="https://github.com/50BytesOfJohn/panqueue"
            target="_blank"
            rel="noopener noreferrer"
            className="underline-offset-2 transition-colors hover:text-fd-primary hover:underline"
          >
            github.com/50BytesOfJohn/panqueue
          </a>
        </p>
      </footer>
    </div>
  );
}

export async function getConfig() {
  return { render: "static" };
}
