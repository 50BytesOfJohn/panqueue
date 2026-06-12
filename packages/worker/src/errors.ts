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
