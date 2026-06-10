/** Max nesting depth before we throw our own error instead of stack-overflowing. */
const MAX_DEPTH = 64;

/**
 * Assert that a value is strictly JSON-serializable.
 *
 * Rejects `undefined`, functions, symbols, `Date` instances, class instances
 * (anything whose prototype is not `Object.prototype` or `Array.prototype`),
 * `BigInt`, `NaN`/`Infinity`, and structures nested deeper than
 * {@link MAX_DEPTH} levels.
 *
 * @throws {TypeError} if the value is not JSON-serializable.
 */
export function assertJsonSerializable(value: unknown): void {
  _assertImpl(value, "payload", 0);
}

function _assertImpl(value: unknown, path: string, depth: number): void {
  if (depth > MAX_DEPTH) {
    throw new TypeError(`${path} exceeds maximum nesting depth of ${MAX_DEPTH}`);
  }
  if (value === null) return;

  switch (typeof value) {
    case "string":
    case "boolean":
      return;
    case "number":
      if (!Number.isFinite(value)) {
        throw new TypeError(`${path} contains a non-finite number (NaN or Infinity)`);
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

  if (value instanceof Date) {
    throw new TypeError(`${path} contains a Date instance`);
  }

  if (value instanceof RegExp) {
    throw new TypeError(`${path} contains a RegExp instance`);
  }

  if (value instanceof Map || value instanceof Set) {
    throw new TypeError(`${path} contains a ${value instanceof Map ? "Map" : "Set"} instance`);
  }

  if (ArrayBuffer.isView(value) || value instanceof ArrayBuffer) {
    throw new TypeError(`${path} contains a binary data view or ArrayBuffer`);
  }

  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) {
      _assertImpl(value[i], `${path}[${i}]`, depth + 1);
    }
    return;
  }

  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) {
    throw new TypeError(`${path} contains a class instance`);
  }

  for (const [key, child] of Object.entries(value)) {
    _assertImpl(child, `${path}.${key}`, depth + 1);
  }
}
