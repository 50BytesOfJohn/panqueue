import { describe, expect, it } from "vitest";

import { deserializeJobHash } from "./job-hash.js";

/** Build the flat `[field, value, …]` array a Lua HGETALL returns. */
function flat(record: Record<string, string>): string[] {
  return Object.entries(record).flat();
}

const baseHash = {
  id: "job-1",
  queueId: "emails",
  status: "active",
  runs: "1",
  maxStalls: "5",
  createdAt: "1700000000000",
  lockToken: "tok",
};

describe("deserializeJobHash", () => {
  it("coerces a numeric hash field into a number", () => {
    // Arrange / Act
    const job = deserializeJobHash(flat({ ...baseHash, payload: "null" }));

    // Assert
    expect(job.runs).toBe(1);
  });

  it("coerces a large numeric hash field into a number", () => {
    // Arrange / Act
    const job = deserializeJobHash(flat({ ...baseHash, payload: "null" }));

    // Assert
    expect(job.createdAt).toBe(1_700_000_000_000);
  });

  it("leaves a string hash field intact", () => {
    // Arrange / Act
    const job = deserializeJobHash(flat({ ...baseHash, payload: "null" }));

    // Assert
    expect(job.lockToken).toBe("tok");
  });

  it("parses the opaque payload back into data", () => {
    // Arrange
    const data = { tags: [], n: 0.30000000000000004 };

    // Act
    const job = deserializeJobHash<typeof data>(
      flat({ ...baseHash, payload: JSON.stringify(data) }),
    );

    // Assert
    expect(job.data).toEqual(data);
  });

  it("throws when identity fields are missing", () => {
    // Arrange / Act / Assert
    expect(() => deserializeJobHash(flat({ status: "active", payload: "{}" }))).toThrow(
      /required identity fields/,
    );
  });

  it("throws when the payload field is absent", () => {
    // Arrange / Act / Assert
    expect(() => deserializeJobHash(flat(baseHash))).toThrow(/missing its payload/);
  });

  it("throws on an empty hash", () => {
    // Arrange / Act / Assert
    expect(() => deserializeJobHash([])).toThrow(/empty job hash/);
  });
});
