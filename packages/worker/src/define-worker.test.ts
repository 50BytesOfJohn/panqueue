import { describe, expect, it } from "vitest";

import { resolveConcurrency } from "./define-worker.js";

describe("resolveConcurrency", () => {
  it("defaults to local 1 when undefined", () => {
    // Arrange / Act
    const result = resolveConcurrency(undefined);

    // Assert
    expect(result).toEqual({ local: 1 });
  });

  it("treats a plain number as local-only", () => {
    // Arrange / Act
    const result = resolveConcurrency(4);

    // Assert
    expect(result).toEqual({ local: 4 });
  });

  it("defaults local to 1 when only global is given", () => {
    // Arrange / Act
    const result = resolveConcurrency({ global: { limit: 10, version: 1 } });

    // Assert
    expect(result).toEqual({ local: 1, global: { limit: 10, version: 1 } });
  });

  it("passes both local and global through", () => {
    // Arrange / Act
    const result = resolveConcurrency({ local: 2, global: { limit: 10, version: 1 } });

    // Assert
    expect(result).toEqual({ local: 2, global: { limit: 10, version: 1 } });
  });
});
