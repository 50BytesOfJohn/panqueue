import { describe, expect, it } from "vitest";

import { jobKey, queueHashTag, queueKey, queueKeys } from "./keys.js";

describe("queueHashTag", () => {
  it("returns the bare hash-tag prefix shared by every key", () => {
    // Arrange / Act / Assert
    expect(queueHashTag("emails")).toBe("{q:emails}");
  });
});

describe("queueKey", () => {
  it("hash-tags the queue id so the suffix lands in the same slot", () => {
    // Arrange / Act
    const key = queueKey("emails", "waiting");

    // Assert
    expect(key).toBe("{q:emails}:waiting");
  });
});

describe("jobKey", () => {
  it("builds a per-job key inside the queue's hash slot", () => {
    // Arrange / Act
    const key = jobKey("emails", "abc123");

    // Assert
    expect(key).toBe("{q:emails}:job:abc123");
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
});
