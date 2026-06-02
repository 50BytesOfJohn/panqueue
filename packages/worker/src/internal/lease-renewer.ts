import type { BaseJobScheduler } from "../scheduler/base.js";

/** Collaborators and tuning a {@link LeaseRenewer} needs. */
export interface LeaseRenewerOptions {
  scheduler: Pick<BaseJobScheduler, "extendLock">;
  leaseMs: number;
  lockRenewMs: number;
  onError(context: string, error: unknown): void;
  onJobCorrupt(jobId: string, reason: string): void;
}

/** Handle controlling a single claimed job's lease renewal. */
export interface LeaseRenewal {
  stop(): void;
}

/**
 * Keeps the lease alive for in-flight jobs by periodically extending the
 * lock, fenced on the job's lockToken. One {@link LeaseRenewer} is shared by
 * a runner; {@link LeaseRenewer.start} spins up an independent timer per job.
 */
export class LeaseRenewer {
  readonly #scheduler: Pick<BaseJobScheduler, "extendLock">;
  readonly #leaseMs: number;
  readonly #lockRenewMs: number;
  readonly #onError: (context: string, error: unknown) => void;
  readonly #onJobCorrupt: (jobId: string, reason: string) => void;

  constructor(options: LeaseRenewerOptions) {
    this.#scheduler = options.scheduler;
    this.#leaseMs = options.leaseMs;
    this.#lockRenewMs = options.lockRenewMs;
    this.#onError = options.onError;
    this.#onJobCorrupt = options.onJobCorrupt;
  }

  /**
   * Begin renewing the lease for a claimed job. Renewal is disabled (a no-op
   * handle is returned) when the job has no lockToken or renewal is turned off.
   */
  start(jobId: string, lockToken: string): LeaseRenewal {
    if (!lockToken || this.#lockRenewMs <= 0) {
      return { stop: () => {} };
    }

    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const tick = async () => {
      if (stopped) return;
      try {
        const ok = await this.#scheduler.extendLock(jobId, this.#leaseMs, lockToken);
        if (ok !== "extended") {
          if (ok === "corrupt") {
            this.#onJobCorrupt(jobId, "invalid-json");
          }
          this.#onError(
            `lease-lost:${jobId}`,
            new Error(
              "Lease lost while job was running. Recovery may have requeued it; complete/fail will be no-ops.",
            ),
          );
          stopped = true;
          return;
        }
      } catch (err) {
        this.#onError(`extend:${jobId}`, err);
      }
      if (!stopped) {
        timer = setTimeout(tick, this.#lockRenewMs);
      }
    };

    timer = setTimeout(tick, this.#lockRenewMs);

    return {
      stop: () => {
        stopped = true;
        if (timer) {
          clearTimeout(timer);
          timer = null;
        }
      },
    };
  }
}
