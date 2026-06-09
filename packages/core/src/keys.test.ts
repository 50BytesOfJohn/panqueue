import { describe, expect, it } from "vitest";

import { queueKey, queueKeys } from "./keys.js";

describe("queueKey", () => {
  it("hash-tags the queue id so all suffixes share one slot", () => {
    // Arrange / Act
    const key = queueKey("emails", "waiting");

    // Assert
    expect(key).toBe("{q:emails}:waiting");
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
      corrupt: "{q:emails}:corrupt",
      corruptData: "{q:emails}:corrupt:data",
      jobs: "{q:emails}:jobs",
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
