import { PanqueueError } from "@panqueue/core";

/**
 * The pool could not establish its Redis connections during `start()`.
 * The initial connect fails fast so a supervisor can restart the process;
 * once running, established connections reconnect indefinitely instead.
 */
export class WorkerConnectionError extends PanqueueError {
  constructor(cause: unknown) {
    const detail = cause instanceof Error ? cause.message : String(cause);
    super(`Redis connection failed: ${detail}`, { cause });
  }
}

/**
 * The queue's stored global concurrency declaration has the same version but
 * a different limit — an operator error (two deploys disagree). Thrown from
 * `WorkerPool.start()`; fix by bumping `concurrency.global.version` alongside
 * the new limit, or reverting the limit change.
 */
export class ConcurrencyLimitConflictError extends PanqueueError {
  constructor(queueId: string, version: number, storedLimit: number, requestedLimit: number) {
    super(
      `Global concurrency conflict for queue "${queueId}": version ${version} already ` +
        `declares limit ${storedLimit}, got ${requestedLimit}. Bump the version to change the limit.`,
    );
  }
}
