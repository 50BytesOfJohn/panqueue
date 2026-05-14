import { type Spy, spy } from "jsr:@std/testing/mock";
import type {
  PanqueueSubscriber,
  PanqueueWorkerClient,
} from "../redis_connection.ts";

/** Options for {@link createFakeClient}. */
export interface FakeClientOptions {
  /** Sequential return values consumed by every spied script call. */
  evalResults?: unknown[];
  /** Single function used by every spied script call. Wins over evalResults. */
  // deno-lint-ignore no-explicit-any
  evalFn?: (...args: any[]) => unknown;
}

/**
 * A fake Redis client shared by runner and pool tests. Exposes both the
 * command-mode and subscriber-mode surfaces so the same fake can stand in for
 * either side of `createClient`.
 */
export type FakeClient =
  & PanqueueWorkerClient
  & PanqueueSubscriber
  & {
    connect: Spy;
    disconnect: Spy;
    on: Spy;
    subscribe: Spy;
    unsubscribe: Spy;
    duplicate: Spy;
    claimGlobal: Spy;
    complete: Spy;
    fail: Spy;
    recover: Spy;
    extendLock: Spy;
    requeueActive: Spy;
  };

/** Build a fake `RedisClient` for use in tests. */
export function createFakeClient(options?: FakeClientOptions): FakeClient {
  const evalResults = options?.evalResults ?? [];
  let i = 0;
  // deno-lint-ignore no-explicit-any
  const sharedImpl = options?.evalFn ?? ((..._args: any[]) => {
    const result = evalResults[i] ?? null;
    i++;
    return Promise.resolve(result);
  });

  return {
    connect: spy(() => Promise.resolve()),
    disconnect: spy(() => Promise.resolve()),
    on: spy(),
    subscribe: spy(
      (_channel: string | string[], _cb: () => void) => Promise.resolve(),
    ),
    unsubscribe: spy(() => Promise.resolve()),
    duplicate: spy(),
    claimGlobal: spy(sharedImpl),
    complete: spy(sharedImpl),
    fail: spy(sharedImpl),
    recover: spy(sharedImpl),
    extendLock: spy(sharedImpl),
    requeueActive: spy(sharedImpl),
  } as unknown as FakeClient;
}

/** Capture errors emitted via the `onError` event handler. */
export function createErrorCapture() {
  const errors: { context: string; error: unknown }[] = [];
  return {
    errors,
    onError: (context: string, error: unknown) => {
      errors.push({ context, error });
    },
  };
}
