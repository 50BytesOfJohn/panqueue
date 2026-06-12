/**
 * Base class for every error thrown across a Panqueue public boundary.
 *
 * Package-specific errors extend this in their respective packages, so
 * `err instanceof PanqueueError` distinguishes Panqueue failures from
 * unrelated errors regardless of which package threw.
 */
export class PanqueueError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = new.target.name;
  }
}

/**
 * A job payload is not strictly JSON-serializable. Thrown synchronously at
 * enqueue time, before anything is sent to Redis. Always a programmer error;
 * never retryable.
 */
export class SerializationError extends PanqueueError {}
