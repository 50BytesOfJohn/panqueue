import type { BaseJobScheduler } from "../scheduler/base.js";

/** Collaborators and tuning a {@link StalledRecoverySweep} needs. */
export interface StalledRecoverySweepOptions {
  scheduler: Pick<BaseJobScheduler, "recover">;
  intervalMs: number;
  batchSize: number;
  /** Whether sweeping should currently run (e.g. runner still "running"). */
  isActive(): boolean;
  onJobRecovered(jobIds: string[]): void;
  onError(context: string, error: unknown): void;
  onJobCorrupt(jobId: string, reason: string): void;
}

/**
 * Periodically asks the scheduler to recover jobs whose lease expired,
 * routing corrupt quarantines and recovered ids to the runner's events.
 */
export class StalledRecoverySweep {
  readonly #scheduler: Pick<BaseJobScheduler, "recover">;
  readonly #intervalMs: number;
  readonly #batchSize: number;
  readonly #isActive: () => boolean;
  readonly #onJobRecovered: (jobIds: string[]) => void;
  readonly #onError: (context: string, error: unknown) => void;
  readonly #onJobCorrupt: (jobId: string, reason: string) => void;

  #timer: ReturnType<typeof setInterval> | null = null;

  constructor(options: StalledRecoverySweepOptions) {
    this.#scheduler = options.scheduler;
    this.#intervalMs = options.intervalMs;
    this.#batchSize = options.batchSize;
    this.#isActive = options.isActive;
    this.#onJobRecovered = options.onJobRecovered;
    this.#onError = options.onError;
    this.#onJobCorrupt = options.onJobCorrupt;
  }

  /** Start the recurring sweep. Disabled when the interval is non-positive. */
  start(): void {
    if (this.#intervalMs <= 0) return;
    this.#timer = setInterval(() => {
      this.run();
    }, this.#intervalMs);
  }

  /** Stop the recurring sweep. Safe to call when not started. */
  stop(): void {
    if (this.#timer) {
      clearInterval(this.#timer);
      this.#timer = null;
    }
  }

  /** Run a single recovery pass. */
  async run(): Promise<void> {
    if (!this.#isActive()) return;
    try {
      const recovered = await this.#scheduler.recover(this.#batchSize);
      if (recovered.length === 0) return;

      const recoveredJobIds = recovered.filter(
        (id) => !id.startsWith("corrupt:"),
      );
      for (const id of recovered) {
        if (id.startsWith("corrupt:")) {
          this.#onJobCorrupt(id.slice("corrupt:".length), "invalid-json");
        }
      }
      if (recoveredJobIds.length === 0) return;
      this.#onJobRecovered(recoveredJobIds);
    } catch (err) {
      this.#onError("recover", err);
    }
  }
}
