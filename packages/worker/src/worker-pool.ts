import type { PanqueueConfig, QueueConfig } from "@panqueue/config";
import {
  type ConnectionOptions,
  DEFAULT_COMPLETED_RETENTION,
  DEFAULT_FAILED_RETENTION,
  notifyKey,
  PanqueueError,
  type QueueMap,
  resolveRetention,
} from "@panqueue/core";

import { isWorkerDefinition, type WorkerDefinition } from "./define-worker.js";
import { WorkerConnectionError } from "./errors.js";
import { WorkerRunner } from "./internal/worker-runner.js";
import {
  type ConnectionLifecycleHooks,
  RedisConnection,
  type RedisSubscriberConnection,
} from "./redis-connection.js";

/** Options accepted by {@link WorkerPool.shutdown}. */
export interface ShutdownOptions {
  /**
   * When true, wait for in-flight jobs to acknowledge (complete/fail) before
   * disconnecting Redis. When false (the default), in-flight jobs are
   * immediately handed back to the queue via an atomic requeue script so
   * another worker can pick them up without waiting for the lease to expire.
   *
   * Force shutdown (the default) relies on the at-least-once contract:
   * processors must be idempotent because a force-shutdown job is
   * re-executed on the next worker that claims it. The local handler keeps
   * running until the process exits, but its eventual complete/fail
   * no-ops because the lockToken has been cleared.
   *
   * Default: `false` (force).
   */
  drain?: boolean;
  /**
   * Drain timeout in milliseconds. If the drain does not finish in time,
   * still-in-flight jobs are requeued and Redis is disconnected so the
   * pool never silently exits under live work. The timeout is a single
   * pool-wide budget — not per-runner. Ignored when `drain` is false.
   * Default: no timeout (wait indefinitely).
   */
  timeout?: number;
}

/** Result returned by `WorkerPool.shutdown`. */
export interface ShutdownResult {
  /** The mode this shutdown ran in. */
  mode: "force" | "drain";
  /** Whether a drain timed out before all jobs finished (drain mode only). */
  timedOut: boolean;
  /** Number of jobs still in-flight when shutdown returned (across all queues). */
  unfinishedJobs: number;
  /** Number of in-flight jobs successfully requeued for another worker. */
  requeued: number;
}

/** Which of the pool's two Redis connections an event refers to. */
export type PoolConnection = "command" | "subscriber";

/** Payload for {@link WorkerPoolEventHandlers.onConnectionError}. */
export interface PoolConnectionErrorEvent {
  connection: PoolConnection;
  error: unknown;
}

/** Payload for connection lifecycle events. */
export interface PoolConnectionEvent {
  connection: PoolConnection;
}

/** Payload for {@link WorkerPoolEventHandlers.onNotificationsDegraded}. */
export interface NotificationsDegradedEvent {
  /** The last socket error observed before degrading, when available. */
  error?: unknown;
}

/**
 * Pool-level observability handlers for the shared Redis connections. Job
 * lifecycle events live on the worker definitions; everything about the
 * sockets the pool owns surfaces here. All handlers are fire-and-forget: a
 * throwing handler is swallowed and never affects the pool.
 */
export interface WorkerPoolEventHandlers {
  /** Called on every socket-level error on either connection. */
  onConnectionError?(event: PoolConnectionErrorEvent): void;
  /** Called when a connection is lost and a reconnect attempt is scheduled. */
  onConnectionReconnecting?(event: PoolConnectionEvent): void;
  /** Called when a connection is established or re-established. */
  onConnectionReady?(event: PoolConnectionEvent): void;
  /**
   * Called once when the subscriber connection drops. While degraded,
   * workers receive no pub/sub wakeups and fall back to `pollInterval`
   * polling — jobs still process, with up to `pollInterval` extra latency.
   */
  onNotificationsDegraded?(event: NotificationsDegradedEvent): void;
  /** Called when the subscriber connection recovers after degrading. */
  onNotificationsRestored?(): void;
}

/** Options for constructing a {@link WorkerPool}. */
export interface WorkerPoolOptions<TQueues extends QueueMap = QueueMap> {
  /** Worker definitions to materialize when the pool starts. */
  workers: WorkerDefinition<TQueues, keyof TQueues & string>[];
  /**
   * Redis connection used by every runner in this pool. Overrides
   * `config.redis` when provided.
   */
  connection?: ConnectionOptions;
  /** Pool-level connection event handlers for observability. */
  events?: WorkerPoolEventHandlers;
}

/** Lifecycle states of the pool. */
type PoolState = "idle" | "starting" | "running" | "stopping" | "stopped";

/**
 * Owns Redis connections and runs the workers attached at construction
 * time. A pool opens exactly one command client and one subscriber socket,
 * shared across every registered queue.
 *
 * Pools are single-shot: after `shutdown()` resolves, `start()` rejects.
 * Construct a fresh pool to run again.
 *
 * @example
 * ```ts
 * await using pool = new WorkerPool(pq, {
 *   workers: [emailWorker, imageWorker],
 * });
 * await pool.start();
 * ```
 */
export class WorkerPool<TQueues extends QueueMap = QueueMap> {
  readonly #connectionOptions: ConnectionOptions;
  readonly #definitions: ReadonlyArray<WorkerDefinition<TQueues>>;
  readonly #queueConfigs: Partial<Record<string, QueueConfig>>;
  readonly #events: WorkerPoolEventHandlers;

  #state: PoolState = "idle";
  #notificationsDegraded = false;
  #lastSubscriberError: unknown;
  #startPromise: Promise<void> | null = null;
  #shutdownPromise: Promise<ShutdownResult> | null = null;

  #redis: RedisConnection | null = null;
  #subscriber: RedisSubscriberConnection | null = null;
  #runners: WorkerRunner[] = [];

  constructor(config: PanqueueConfig<TQueues>, options: WorkerPoolOptions<TQueues>) {
    if (!options.workers || options.workers.length === 0) {
      throw new PanqueueError("WorkerPool requires at least one worker definition");
    }

    const seen = new Set<string>();
    for (const def of options.workers) {
      if (!isWorkerDefinition(def)) {
        throw new PanqueueError("WorkerPool workers must be created with defineWorker(...)");
      }
      if (seen.has(def.queueId)) {
        throw new PanqueueError(`Duplicate worker definition for queue "${def.queueId}"`);
      }
      seen.add(def.queueId);
    }

    this.#connectionOptions = options.connection ?? config.redis;
    this.#definitions = options.workers;
    this.#queueConfigs = config.queues;
    this.#events = options.events ?? {};
  }

  /** Number of registered queues. */
  get size(): number {
    return this.#definitions.length;
  }

  /** Open Redis connections, subscribe to notifications, and start every runner. */
  start(): Promise<void> {
    if (this.#state === "running") return Promise.resolve();
    if (this.#startPromise) return this.#startPromise;
    if (this.#state !== "idle") {
      return Promise.reject(new PanqueueError(`Cannot start pool in state "${this.#state}"`));
    }

    this.#startPromise = this.#doStart().finally(() => {
      this.#startPromise = null;
    });
    return this.#startPromise;
  }

  async #doStart(): Promise<void> {
    this.#state = "starting";

    const redis = new RedisConnection(this.#connectionOptions, this.#connectionHooks("command"));
    let subscriber: RedisSubscriberConnection | null = null;
    const subscribedChannels: string[] = [];

    try {
      await redis.connect();
      subscriber = await redis.duplicate(this.#subscriberHooks());

      const runners = this.#definitions.map((def) => {
        const rule = this.#queueConfigs[def.queueId]?.retention;
        const retention = {
          completed: resolveRetention(rule?.completed, DEFAULT_COMPLETED_RETENTION),
          failed: resolveRetention(rule?.failed, DEFAULT_FAILED_RETENTION),
        };
        return new WorkerRunner(def.queueId, def.processor, def.options, redis.client, retention);
      });

      for (const runner of runners) {
        const channel = notifyKey(runner.queueId);
        await subscriber.client.subscribe(channel, () => runner.wake());
        subscribedChannels.push(channel);
      }

      for (const runner of runners) runner.start();

      this.#redis = redis;
      this.#subscriber = subscriber;
      this.#runners = runners;
      this.#state = "running";
    } catch (err) {
      if (subscriber && subscribedChannels.length > 0) {
        try {
          await subscriber.client.unsubscribe(subscribedChannels);
        } catch {
          /* ignore */
        }
      }
      try {
        await subscriber?.disconnect();
      } catch {
        /* ignore */
      }
      try {
        await redis.disconnect();
      } catch {
        /* ignore */
      }
      this.#state = "stopped";
      if (err instanceof PanqueueError) throw err;
      throw new WorkerConnectionError(err);
    }
  }

  /** Lifecycle hooks routing a connection's socket events to pool handlers. */
  #connectionHooks(connection: PoolConnection): ConnectionLifecycleHooks {
    return {
      onError: (error) =>
        this.#safeEmit(() => this.#events.onConnectionError?.({ connection, error })),
      onReconnecting: () =>
        this.#safeEmit(() => this.#events.onConnectionReconnecting?.({ connection })),
      onReady: () => this.#safeEmit(() => this.#events.onConnectionReady?.({ connection })),
    };
  }

  /**
   * Subscriber hooks additionally track notification degradation: while the
   * subscriber socket is down, workers miss pub/sub wakeups and fall back to
   * polling. Degraded/restored fire once per outage, not per retry.
   */
  #subscriberHooks(): ConnectionLifecycleHooks {
    const base = this.#connectionHooks("subscriber");
    return {
      onError: (error) => {
        this.#lastSubscriberError = error;
        base.onError?.(error);
      },
      onReconnecting: () => {
        if (!this.#notificationsDegraded) {
          this.#notificationsDegraded = true;
          this.#safeEmit(() =>
            this.#events.onNotificationsDegraded?.({ error: this.#lastSubscriberError }),
          );
        }
        base.onReconnecting?.();
      },
      onReady: () => {
        if (this.#notificationsDegraded) {
          this.#notificationsDegraded = false;
          this.#lastSubscriberError = undefined;
          this.#safeEmit(() => this.#events.onNotificationsRestored?.());
        }
        base.onReady?.();
      },
    };
  }

  /** Invoke an observability handler; handler failures never affect the pool. */
  #safeEmit(emit: () => void): void {
    try {
      emit();
    } catch {
      /* observability handlers must not break the pool */
    }
  }

  /**
   * Shut down every runner and disconnect Redis. Defaults to force mode —
   * see {@link ShutdownOptions}.
   *
   * Idempotent: subsequent calls return the same result.
   */
  shutdown(options?: ShutdownOptions): Promise<ShutdownResult> {
    const drain = options?.drain ?? false;
    const mode: "force" | "drain" = drain ? "drain" : "force";

    if (this.#shutdownPromise) return this.#shutdownPromise;

    if (this.#state === "idle") {
      const result: ShutdownResult = {
        mode,
        timedOut: false,
        unfinishedJobs: 0,
        requeued: 0,
      };
      this.#state = "stopped";
      this.#shutdownPromise = Promise.resolve(result);
      return this.#shutdownPromise;
    }

    this.#shutdownPromise = this.#doShutdown(mode, options);
    return this.#shutdownPromise;
  }

  async #doShutdown(mode: "force" | "drain", options?: ShutdownOptions): Promise<ShutdownResult> {
    if (this.#startPromise) {
      try {
        await this.#startPromise;
      } catch {
        /* ignore */
      }
    }

    if (this.#state !== "running") {
      const result: ShutdownResult = {
        mode,
        timedOut: false,
        unfinishedJobs: 0,
        requeued: 0,
      };
      this.#state = "stopped";
      return result;
    }

    this.#state = "stopping";
    const runners = this.#runners;

    await Promise.allSettled(runners.map((r) => r.stopClaiming()));

    let timedOut = false;

    if (mode === "drain") {
      const drainResults = await Promise.all(runners.map((r) => r.drainInflight(options?.timeout)));
      timedOut = drainResults.some((r) => r.timedOut);
    }

    const reason = mode === "drain" ? "shutdown-timeout" : "shutdown";
    const requeueResults = await Promise.all(runners.map((r) => r.forceRequeueInflight(reason)));

    let unfinishedJobs = 0;
    let requeued = 0;
    for (const r of requeueResults) {
      unfinishedJobs += r.unfinishedJobs;
      requeued += r.requeued;
    }

    const channels = runners.map((r) => notifyKey(r.queueId));
    if (this.#subscriber && channels.length > 0) {
      try {
        await this.#subscriber.client.unsubscribe(channels);
      } catch {
        /* ignore */
      }
    }
    try {
      await this.#subscriber?.disconnect();
    } catch {
      /* ignore */
    }
    try {
      await this.#redis?.disconnect();
    } catch {
      /* ignore */
    }

    for (const runner of runners) runner.finalize();

    this.#redis = null;
    this.#subscriber = null;
    this.#runners = [];
    this.#state = "stopped";

    return { mode, timedOut, unfinishedJobs, requeued };
  }

  async [Symbol.asyncDispose](): Promise<void> {
    await this.shutdown();
  }
}
