/**
 * Assert that a value is strictly JSON-serializable.
 *
 * Rejects `undefined`, functions, symbols, `Date` instances, class instances
 * (anything whose prototype is not `Object.prototype` or `Array.prototype`),
 * `BigInt`, and `NaN`/`Infinity`.
 *
 * @throws {TypeError} if the value is not JSON-serializable.
 */
export function assertJsonSerializable(value: unknown): void {
  _assertImpl(value, "payload");
}

function _assertImpl(value: unknown, path: string): void {
  if (value === null) return;

  switch (typeof value) {
    case "string":
    case "boolean":
      return;
    case "number":
      if (!Number.isFinite(value)) {
        throw new TypeError(
          `${path} contains a non-finite number (NaN or Infinity)`,
        );
      }
      return;
    case "undefined":
      throw new TypeError(`${path} contains undefined`);
    case "function":
      throw new TypeError(`${path} contains a function`);
    case "symbol":
      throw new TypeError(`${path} contains a symbol`);
    case "bigint":
      throw new TypeError(`${path} contains a BigInt`);
    default:
      break;
  }

  // value is an object — check for class instances
  if (value instanceof Date) {
    throw new TypeError(`${path} contains a Date instance`);
  }

  if (value instanceof RegExp) {
    throw new TypeError(`${path} contains a RegExp instance`);
  }

  if (value instanceof Map || value instanceof Set) {
    throw new TypeError(
      `${path} contains a ${value instanceof Map ? "Map" : "Set"} instance`,
    );
  }

  if (ArrayBuffer.isView(value) || value instanceof ArrayBuffer) {
    throw new TypeError(`${path} contains a binary data view or ArrayBuffer`);
  }

  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) {
      _assertImpl(value[i], `${path}[${i}]`);
    }
    return;
  }

  // Plain object check
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) {
    throw new TypeError(`${path} contains a class instance`);
  }

  for (const key of Object.keys(value as Record<string, unknown>)) {
    _assertImpl((value as Record<string, unknown>)[key], `${path}.${key}`);
  }
}
