import { describe, expect, it } from "vitest";

import { generateJobId } from "./job-id.js";

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

describe("generateJobId", () => {
  it("returns a v4 UUID", () => {
    // Arrange / Act
    const id = generateJobId();

    // Assert
    expect(id).toMatch(uuidPattern);
  });

  it("returns a different id on every call", () => {
    // Arrange
    const ids = new Set(Array.from({ length: 100 }, () => generateJobId()));

    // Assert — collisions in 100 UUIDs are astronomically unlikely.
    expect(ids.size).toBe(100);
  });
});
