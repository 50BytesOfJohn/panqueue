import { Link } from 'waku';
import { ArrowRight, ShieldCheck, Zap, RefreshCw, Lock, AlertTriangle, Server } from 'lucide-react';
import { Cards, Card } from 'fumadocs-ui/components/card';
import { Steps, Step } from 'fumadocs-ui/components/steps';
import { DynamicCodeBlock } from 'fumadocs-ui/components/dynamic-codeblock';
import { Tabs, Tab } from 'fumadocs-ui/components/tabs';
import { Callout } from 'fumadocs-ui/components/callout';
import { CopyButton } from '@/components/ui/copy-button';

const INSTALL_CMD =
  'deno add jsr:@panqueue/config jsr:@panqueue/client jsr:@panqueue/worker';

const CONFIG_CODE = `import { definePanqueueConfig } from "@panqueue/config";

const config = definePanqueueConfig({
  redis: { url: "redis://localhost:6379" },
  queues: {
    email:     {},
    thumbnail: {},
  },
});`;

const ENQUEUE_CODE = `import { createQueueClient } from "@panqueue/client";

const client = createQueueClient(config);
await client.connect();

await client.enqueue("email", {
  to: "user@example.com",
  subject: "Welcome!",
});

await client.disconnect();`;

const WORKER_CODE = `import { defineWorker, WorkerPool } from "@panqueue/worker";

const emailWorker = defineWorker(config, "email", async (job) => {
  await sendEmail(job.data);
}, {
  concurrency: 5,
  events: {
    onJobComplete(job) { console.log("sent", job.data.subject); },
    onJobFail(job, err)  { console.error("failed", err); },
  },
});

const pool = new WorkerPool(config, { workers: [emailWorker] });
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
      <section className="relative flex flex-col items-center justify-center min-h-[calc(100vh-4rem)] px-6 py-28 text-center overflow-hidden">
        {/* ambient glow */}
        <div
          className="pointer-events-none absolute inset-0"
          style={{
            background:
              'radial-gradient(ellipse 55% 35% at 50% 28%, hsla(38,80%,50%,0.09) 0%, transparent 70%)',
          }}
        />

        {/* Logo */}
        <div className="relative mb-8">
          <div
            className="absolute inset-0 rounded-full blur-3xl opacity-50"
            style={{ background: 'hsla(38,80%,50%,0.2)', transform: 'scale(1.6)' }}
          />
          <img
            src="/logo.png"
            alt="panqueue mascot"
            width={96}
            height={96}
            className="relative drop-shadow-xl"
          />
        </div>

        {/* Status badge */}
        <div className="mb-6 inline-flex items-center gap-2 rounded-full border border-fd-border bg-fd-card px-3 py-1 text-xs text-fd-muted-foreground">
          <span className="h-1.5 w-1.5 rounded-full bg-fd-primary animate-pulse" />
          Pre-release · v0.0.1 · Deno · Redis 7+
        </div>

        {/* Title */}
        <h1 className="mb-4 text-6xl font-extrabold tracking-tight text-fd-foreground sm:text-7xl lg:text-8xl">
          pan<span className="text-fd-primary">queue</span>
        </h1>

        <p className="mb-2 text-lg font-medium text-fd-muted-foreground sm:text-xl">
          Redis-backed job queue for Deno
        </p>
        <p className="mb-10 max-w-md text-sm leading-relaxed text-fd-muted-foreground/70">
          Type-safe queues with at-least-once delivery, lease-based recovery, and
          atomic Lua scripts. No race conditions.
        </p>

        {/* Install command */}
        <div className="mb-8 w-full max-w-xl">
          <div className="flex items-center gap-3 rounded-xl border border-fd-border bg-fd-card px-4 py-3 font-mono text-sm">
            <span className="text-fd-primary select-none">$</span>
            <span className="flex-1 text-left truncate text-fd-foreground/80">{INSTALL_CMD}</span>
            <CopyButton text={INSTALL_CMD} />
          </div>
        </div>

        {/* CTAs */}
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
          Panqueue is stabilising toward v0.1. The core API is solid but may still change.
          Follow{' '}
          <a
            href="https://github.com/50BytesOfJohn/panqueue"
            className="underline underline-offset-2"
          >
            the repo
          </a>{' '}
          for updates.
        </Callout>
      </div>

      {/* ── Features ─────────────────────────────────────── */}
      <section className="px-6 py-20">
        <div className="mx-auto max-w-4xl">
          <div className="mb-12 text-center">
            <p className="mb-2 text-xs font-semibold uppercase tracking-widest text-fd-primary">
              Features
            </p>
            <h2 className="text-3xl font-bold text-fd-foreground sm:text-4xl">
              Built for reliability
            </h2>
            <p className="mt-3 text-sm text-fd-muted-foreground">
              Everything you need to run jobs in production without losing work.
            </p>
          </div>

          <Cards>
            <Card
              icon={<ShieldCheck size={18} className="text-fd-primary" />}
              title="Type-safe end to end"
              description="Shared config ties queue IDs to payload types — enqueue and defineWorker infer the right shapes automatically."
            />
            <Card
              icon={<RefreshCw size={18} className="text-fd-primary" />}
              title="At-least-once delivery"
              description="Lease-based stalled-job recovery reclaims work from crashed or unresponsive workers without data loss."
            />
            <Card
              icon={<Zap size={18} className="text-fd-primary" />}
              title="Atomic Redis scripts"
              description="Every state transition runs inside a single Lua call — no race conditions, no partial updates."
            />
            <Card
              icon={<Lock size={18} className="text-fd-primary" />}
              title="Force-shutdown by default"
              description="In-flight jobs are atomically requeued on shutdown so another worker picks them up immediately."
            />
            <Card
              icon={<AlertTriangle size={18} className="text-fd-primary" />}
              title="Corrupt-job quarantining"
              description="Malformed Redis data is isolated to a dead-letter queue instead of silently dropped."
            />
            <Card
              icon={<Server size={18} className="text-fd-primary" />}
              title="Cluster-ready"
              description="All keys use hash tags ({q:<id>}) for Redis Cluster compatibility out of the box."
            />
          </Cards>
        </div>
      </section>

      {/* ── Quick start ───────────────────────────────────── */}
      <section className="border-t border-fd-border px-6 py-20">
        <div className="mx-auto max-w-4xl">
          <div className="mb-12 text-center">
            <p className="mb-2 text-xs font-semibold uppercase tracking-widest text-fd-primary">
              Quick start
            </p>
            <h2 className="text-3xl font-bold text-fd-foreground sm:text-4xl">
              Up and running in minutes
            </h2>
            <p className="mt-3 text-sm text-fd-muted-foreground">
              Three packages. Three steps.
            </p>
          </div>

          <Steps>
            <Step>
              <h3 className="text-base font-semibold text-fd-foreground mb-3">
                Define your queues
              </h3>
              <DynamicCodeBlock lang="ts" code={CONFIG_CODE} codeblock={{ title: 'config.ts' }} />
            </Step>

            <Step>
              <h3 className="text-base font-semibold text-fd-foreground mb-3">
                Enqueue jobs
              </h3>
              <DynamicCodeBlock lang="ts" code={ENQUEUE_CODE} codeblock={{ title: 'enqueue.ts' }} />
            </Step>

            <Step>
              <h3 className="text-base font-semibold text-fd-foreground mb-3">
                Define workers and run them
              </h3>
              <DynamicCodeBlock lang="ts" code={WORKER_CODE} codeblock={{ title: 'worker.ts' }} />
            </Step>
          </Steps>
        </div>
      </section>

      {/* ── Shutdown semantics ────────────────────────────── */}
      <section className="border-t border-fd-border px-6 py-20">
        <div className="mx-auto max-w-4xl">
          <div className="mb-8 text-center">
            <p className="mb-2 text-xs font-semibold uppercase tracking-widest text-fd-primary">
              Shutdown
            </p>
            <h2 className="text-2xl font-bold text-fd-foreground sm:text-3xl">
              No jobs left behind
            </h2>
            <p className="mt-3 text-sm text-fd-muted-foreground max-w-lg mx-auto">
              Force mode atomically requeues all in-flight jobs before disconnecting.
              Drain mode waits for handlers to finish, with a timeout fallback.
            </p>
          </div>

          <Tabs items={['Force (default)', 'Drain']}>
            <Tab value="Force (default)">
              <DynamicCodeBlock
                lang="ts"
                code={`// Atomically requeues in-flight jobs → disconnects immediately
const result = await pool.shutdown();
// result: ShutdownResult { mode: "force", timedOut: false, unfinishedJobs: 0, requeued: 3 }`}
                codeblock={{ title: 'shutdown.ts' }}
              />
            </Tab>
            <Tab value="Drain">
              <DynamicCodeBlock
                lang="ts"
                code={`// Waits for handlers; force-requeues on timeout
const result = await pool.shutdown({ drain: true, timeout: 30_000 });
// result: ShutdownResult { mode: "drain", timedOut: false, unfinishedJobs: 0, requeued: 1 }`}
                codeblock={{ title: 'shutdown.ts' }}
              />
            </Tab>
          </Tabs>
        </div>
      </section>

      {/* ── CTA banner ────────────────────────────────────── */}
      <section className="border-t border-fd-border px-6 py-20">
        <div
          className="mx-auto max-w-4xl overflow-hidden rounded-2xl border border-fd-border p-10 text-center"
          style={{
            background:
              'radial-gradient(ellipse 70% 90% at 50% 0%, hsla(38,80%,50%,0.07) 0%, transparent 70%), var(--color-fd-card)',
          }}
        >
          <h2 className="mb-3 text-2xl font-bold text-fd-foreground sm:text-3xl">
            Ready to start cooking?
          </h2>
          <p className="mb-8 text-sm text-fd-muted-foreground">
            Read the docs to explore the full API, worker options, and job lifecycle.
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
          MIT License ·{' '}
          <a
            href="https://github.com/50BytesOfJohn/panqueue"
            target="_blank"
            rel="noopener noreferrer"
            className="hover:text-fd-primary transition-colors underline-offset-2 hover:underline"
          >
            github.com/50BytesOfJohn/panqueue
          </a>
        </p>
      </footer>
    </div>
  );
}

export async function getConfig() {
  return { render: 'static' };
}
