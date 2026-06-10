import { describe, expect, it } from "vitest";

import {
  DEFAULT_COMPLETED_RETENTION,
  DEFAULT_FAILED_RETENTION,
  type ResolvedRetention,
  type RetentionRule,
  resolveRetention,
} from "./retention.js";

describe("resolveRetention", () => {
  it.each<[rule: RetentionRule, expected: ResolvedRetention]>([
    [false, { mode: "delete", ttl: -1, count: -1 }],
    [true, { mode: "keep", ttl: -1, count: -1 }],
    [{ ttl: 5000 }, { mode: "trim", ttl: 5000, count: -1 }],
    [{ count: 100 }, { mode: "trim", ttl: -1, count: 100 }],
    [
      { ttl: 5000, count: 100 },
      { mode: "trim", ttl: 5000, count: 100 },
    ],
    [{}, { mode: "keep", ttl: -1, count: -1 }],
  ])("resolves rule %j to %j", (rule, expected) => {
    // Act
    const resolved = resolveRetention(rule, true);

    // Assert
    expect(resolved).toEqual(expected);
  });

  it("undefined resolves the fallback rule", () => {
    // Act
    const resolved = resolveRetention(undefined, { ttl: 1000, count: 5 });

    // Assert
    expect(resolved).toEqual({ mode: "trim", ttl: 1000, count: 5 });
  });

  it("default completed retention resolves to delete", () => {
    // Act
    const resolved = resolveRetention(undefined, DEFAULT_COMPLETED_RETENTION);

    // Assert
    expect(resolved).toEqual({ mode: "delete", ttl: -1, count: -1 });
  });

  it("default failed retention resolves to a 7-day / 1000-job trim", () => {
    // Act
    const resolved = resolveRetention(undefined, DEFAULT_FAILED_RETENTION);

    // Assert
    expect(resolved).toEqual({ mode: "trim", ttl: 604_800_000, count: 1000 });
  });
});
