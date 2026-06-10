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
  failures: "0",
  stalls: "0",
  maxRetries: "3",
  maxStalls: "5",
  createdAt: "1700000000000",
  lockToken: "tok",
  leaseDeadline: "1700000030000",
};

describe("deserializeJobHash", () => {
  it("coerces numeric fields and leaves strings intact", () => {
    // Arrange / Act
    const job = deserializeJobHash(flat({ ...baseHash, payload: "null" }));

    // Assert
    expect(job.id).toBe("job-1");
    expect(job.queueId).toBe("emails");
    expect(job.status).toBe("active");
    expect(job.runs).toBe(1);
    expect(job.maxStalls).toBe(5);
    expect(job.createdAt).toBe(1_700_000_000_000);
    expect(job.lockToken).toBe("tok");
  });

  it("parses the opaque payload into data without mangling it", () => {
    // Arrange — the exact values cjson used to corrupt: an empty array and a
    // high-precision float.
    const data = { tags: [], n: 0.30000000000000004 };
    const payload = JSON.stringify(data);

    // Act
    const job = deserializeJobHash<typeof data>(flat({ ...baseHash, payload }));

    // Assert — round-trips byte-for-byte: [] stays [], float is exact.
    expect(job.data).toEqual(data);
    expect(job.data.tags).toEqual([]);
    expect(job.data.n).toBe(0.30000000000000004);
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
