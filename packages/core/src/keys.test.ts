import { describe, expect, it } from "vitest";

import { jobKey, queueHashTag, queueKey, queueKeys } from "./keys.js";

describe("queueKey", () => {
  it("hash-tags the queue id so all suffixes share one slot", () => {
    // Arrange / Act
    const key = queueKey("emails", "waiting");

    // Assert
    expect(key).toBe("{q:emails}:waiting");
  });
});

describe("queueHashTag", () => {
  it("returns the bare hash-tag prefix shared by every key", () => {
    // Arrange / Act / Assert
    expect(queueHashTag("emails")).toBe("{q:emails}");
  });
});

describe("jobKey", () => {
  it("builds a per-job key inside the queue's hash slot", () => {
    // Arrange / Act
    const key = jobKey("emails", "abc123");

    // Assert — same hash tag as the rest of the bundle, distinct suffix.
    expect(key).toBe("{q:emails}:job:abc123");
    expect(key.startsWith(`${queueHashTag("emails")}:`)).toBe(true);
  });
});

describe("queueKeys", () => {
  it("builds every role from the queue id", () => {
    // Arrange / Act
    const keys = queueKeys("emails");

    // Assert — pins the exact strings the Lua bodies assume.
    expect(keys).toEqual({
      waiting: "{q:emails}:waiting",
      active: "{q:emails}:active",
      completed: "{q:emails}:completed",
      failed: "{q:emails}:failed",
      delayed: "{q:emails}:delayed",
      meta: "{q:emails}:meta",
      notify: "{q:emails}:notify",
    });
  });

  it("shares one hash tag across every key", () => {
    // Arrange / Act
    const keys = queueKeys("orders");

    // Assert
    for (const key of Object.values(keys)) {
      expect(key.startsWith("{q:orders}:")).toBe(true);
    }
  });
});
