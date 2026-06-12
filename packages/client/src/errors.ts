import { PanqueueError } from "@panqueue/core";

function describeCause(cause: unknown): string {
  if (cause instanceof Error) return cause.message;
  return String(cause);
}

/**
 * Redis is unreachable: the initial connection failed, or the socket dropped
 * and the command was rejected instead of being buffered. Retryable by
 * contract — the client keeps reconnecting in the background, so a later
 * `enqueue` succeeds once Redis is back.
 */
export class ClientConnectionError extends PanqueueError {
  constructor(cause: unknown) {
    super(`Redis connection failed: ${describeCause(cause)}`, { cause });
  }
}

/**
 * The client was used after `disconnect()`. Clients are single-shot:
 * construct a fresh `QueueClient` to enqueue again.
 */
export class ClientClosedError extends PanqueueError {
  constructor() {
    super("QueueClient is closed. Clients are single-shot; construct a new QueueClient.");
  }
}

/**
 * Redis answered the enqueue command with an error reply (e.g. a script or
 * cluster error). The connection is healthy; the command itself was rejected.
 */
export class EnqueueError extends PanqueueError {
  readonly queueId: string;

  constructor(queueId: string, cause: unknown) {
    super(`Enqueue into queue "${queueId}" failed: ${describeCause(cause)}`, { cause });
    this.queueId = queueId;
  }
}
