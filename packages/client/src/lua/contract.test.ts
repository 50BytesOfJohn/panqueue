import type { CommandParser } from "redis";

import { queueKeys } from "@panqueue/core";
import { describe, expect, it } from "vitest";

import { ENQUEUE_SCRIPT } from "./enqueue.js";

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

describe("enqueue script KEYS contract", () => {
  it("pushes exactly NUMBER_OF_KEYS keys, all from the queue bundle", () => {
    // Arrange
    const keys = queueKeys("t");
    const { parser, keys: pushed } = recordingParser();
    const bundle = new Set<unknown>(Object.values(keys));

    // Act
    ENQUEUE_SCRIPT.parseCommand(parser, keys, {
      jobId: "j",
      payload: "{}",
      queueId: "t",
      maxRetries: 0,
      maxStalls: 5,
      tag: "{q:t}",
    });

    // Assert
    expect(pushed).toHaveLength(ENQUEUE_SCRIPT.NUMBER_OF_KEYS as number);
    for (const key of pushed) {
      expect(bundle.has(key)).toBe(true);
    }
  });
});
