import type { CommandParser } from "redis";

import { queueKeys } from "@panqueue/core";
import { describe, expect, it } from "vitest";

import { WORKER_SCRIPTS } from "../scripts.js";

/**
 * Minimal {@link CommandParser} stand-in that records the keys and args a
 * script's `parseCommand` pushes, so we can assert the irreducible invariant
 * no type system can see: the number of pushed keys must equal the script's
 * `NUMBER_OF_KEYS` (the literal `numkeys` node-redis emits to EVALSHA — drift
 * shifts the KEYS/ARGV boundary on the wire).
 */
function recordingParser(): { parser: CommandParser; keys: unknown[]; args: unknown[] } {
  const keys: unknown[] = [];
  const args: unknown[] = [];
  const parser = {
    pushKey: (key: unknown) => keys.push(key),
    pushKeys: (k: unknown) => keys.push(...(Array.isArray(k) ? k : [k])),
    push: (...a: unknown[]) => args.push(...a),
  } as unknown as CommandParser;
  return { parser, keys, args };
}

const keys = queueKeys("t");

/** Representative non-key args for each script (shape only; values unused). */
const ARGS = {
  claimGlobal: { leaseMs: 1000, tag: "{q:t}" },
  complete: { jobId: "j", lockToken: "tok", tag: "{q:t}" },
  fail: { jobId: "j", error: "boom", lockToken: "tok", tag: "{q:t}" },
  recover: { batchSize: 10, reason: "stalled", tag: "{q:t}" },
  extendLock: { jobId: "j", lockToken: "tok", leaseMs: 1000, tag: "{q:t}" },
  requeueActive: { jobId: "j", lockToken: "tok", reason: "shutdown", tag: "{q:t}" },
} as const;

describe("worker script KEYS contract", () => {
  for (const [name, script] of Object.entries(WORKER_SCRIPTS)) {
    it(`${name}: pushes exactly NUMBER_OF_KEYS keys`, () => {
      // Arrange
      const { parser, keys: pushed } = recordingParser();

      // Act
      script.parseCommand(parser, keys, ARGS[name as keyof typeof ARGS]);

      // Assert
      expect(pushed).toHaveLength(script.NUMBER_OF_KEYS as number);
    });

    it(`${name}: pushes only keys from the queue bundle`, () => {
      // Arrange
      const { parser, keys: pushed } = recordingParser();
      const bundle = new Set<unknown>(Object.values(keys));

      // Act
      script.parseCommand(parser, keys, ARGS[name as keyof typeof ARGS]);

      // Assert — every pushed key is a real key from the bundle, not a stray arg.
      for (const key of pushed) {
        expect(bundle.has(key)).toBe(true);
      }
    });
  }
});
