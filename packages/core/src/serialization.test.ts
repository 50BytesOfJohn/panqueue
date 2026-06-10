import { describe, expect, it } from "vitest";

import { assertJsonSerializable } from "./serialization.js";

describe("assertJsonSerializable", () => {
  it("accepts a plain object with primitive fields", () => {
    // Arrange
    const value = { name: "ada", age: 36, active: true, alias: null };

    // Act & Assert
    expect(() => assertJsonSerializable(value)).not.toThrow();
  });

  it("accepts nested arrays and objects", () => {
    // Arrange
    const value = {
      tags: ["a", "b"],
      meta: { score: 0, nested: { ok: true } },
    };

    // Act & Assert
    expect(() => assertJsonSerializable(value)).not.toThrow();
  });

  it("accepts an empty object", () => {
    // Arrange / Act & Assert
    expect(() => assertJsonSerializable({})).not.toThrow();
  });

  it("accepts an empty array", () => {
    // Arrange / Act & Assert
    expect(() => assertJsonSerializable([])).not.toThrow();
  });

  it("rejects undefined with a path-aware message", () => {
    // Arrange / Act & Assert
    expect(() => assertJsonSerializable({ name: undefined })).toThrow(
      /payload\.name contains undefined/,
    );
  });

  it("rejects a function", () => {
    // Arrange / Act & Assert
    expect(() => assertJsonSerializable({ run: () => 1 })).toThrow(
      /payload\.run contains a function/,
    );
  });

  it("rejects a symbol", () => {
    // Arrange / Act & Assert
    expect(() => assertJsonSerializable({ key: Symbol("k") })).toThrow(
      /payload\.key contains a symbol/,
    );
  });

  it("rejects a BigInt", () => {
    // Arrange / Act & Assert
    expect(() => assertJsonSerializable({ n: 10n })).toThrow(
      /payload\.n contains a BigInt/,
    );
  });

  it("rejects NaN", () => {
    // Arrange / Act & Assert
    expect(() => assertJsonSerializable({ x: NaN })).toThrow(
      /payload\.x contains a non-finite number/,
    );
  });

  it("rejects Infinity", () => {
    // Arrange / Act & Assert
    expect(() => assertJsonSerializable({ x: Infinity })).toThrow(
      /payload\.x contains a non-finite number/,
    );
  });

  it("rejects a Date instance", () => {
    // Arrange / Act & Assert
    expect(() => assertJsonSerializable({ at: new Date() })).toThrow(
      /payload\.at contains a Date instance/,
    );
  });

  it("rejects a RegExp instance", () => {
    // Arrange / Act & Assert
    expect(() => assertJsonSerializable({ pattern: /abc/ })).toThrow(
      /payload\.pattern contains a RegExp instance/,
    );
  });

  it("rejects a Map instance", () => {
    // Arrange / Act & Assert
    expect(() => assertJsonSerializable({ m: new Map([["k", 1]]) })).toThrow(
      /payload\.m contains a Map instance/,
    );
  });

  it("rejects a Set instance", () => {
    // Arrange / Act & Assert
    expect(() => assertJsonSerializable({ s: new Set([1, 2]) })).toThrow(
      /payload\.s contains a Set instance/,
    );
  });

  it("rejects a TypedArray view", () => {
    // Arrange / Act & Assert
    expect(() => assertJsonSerializable({ buf: new Uint8Array(4) })).toThrow(
      /payload\.buf contains a binary data view or ArrayBuffer/,
    );
  });

  it("rejects an ArrayBuffer", () => {
    // Arrange / Act & Assert
    expect(() => assertJsonSerializable({ buf: new ArrayBuffer(4) })).toThrow(
      /payload\.buf contains a binary data view or ArrayBuffer/,
    );
  });

  it("rejects a class instance", () => {
    // Arrange
    class User {
      name = "ada";
    }

    // Act & Assert
    expect(() => assertJsonSerializable({ user: new User() })).toThrow(
      /payload\.user contains a class instance/,
    );
  });

  it("reports the array index in the error path", () => {
    // Arrange / Act & Assert
    expect(() =>
      assertJsonSerializable(["ok", "fine", { bad: undefined }]),
    ).toThrow(/payload\[2\]\.bad contains undefined/);
  });

  it("reports the exact nested path of the offending value", () => {
    // Arrange / Act & Assert
    expect(() =>
      assertJsonSerializable({ a: { b: { c: [1, 2, Symbol()] } } }),
    ).toThrow(/payload\.a\.b\.c\[2\] contains a symbol/);
  });

  it("accepts nesting right at the maximum depth boundary", () => {
    // Arrange — build 64 nested objects (depth 0..64)
    const value: Record<string, unknown> = {};
    let cursor: Record<string, unknown> = value;
    for (let i = 0; i < 64; i++) {
      const next: Record<string, unknown> = {};
      cursor.next = next;
      cursor = next;
    }

    // Act & Assert
    expect(() => assertJsonSerializable(value)).not.toThrow();
  });

  it("rejects nested objects past the maximum depth", () => {
    // Arrange — build 65 nested objects
    const value: Record<string, unknown> = {};
    let cursor: Record<string, unknown> = value;
    for (let i = 0; i < 65; i++) {
      const next: Record<string, unknown> = {};
      cursor.next = next;
      cursor = next;
    }

    // Act & Assert
    expect(() => assertJsonSerializable(value)).toThrow(
      /payload\.next(\.next){64} exceeds maximum nesting depth of 64/,
    );
  });

  it("rejects nested arrays past the maximum depth", () => {
    // Arrange — build 65 nested arrays
    const value: unknown[] = [];
    let cursor: unknown[] = value;
    for (let i = 0; i < 65; i++) {
      const next: unknown[] = [];
      cursor.push(next);
      cursor = next;
    }

    // Act & Assert
    expect(() => assertJsonSerializable(value)).toThrow(
      /payload(\[0\]){65} exceeds maximum nesting depth of 64/,
    );
  });

  it("does not stack overflow on pathologically deep payloads", () => {
    // Arrange — build a deeply nested payload well past any engine limit
    const value: Record<string, unknown> = {};
    let cursor: Record<string, unknown> = value;
    for (let i = 0; i < 10_000; i++) {
      const next: Record<string, unknown> = {};
      cursor.next = next;
      cursor = next;
    }

    // Act & Assert
    expect(() => assertJsonSerializable(value)).toThrow(
      /exceeds maximum nesting depth of 64/,
    );
  });
});
