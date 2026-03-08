/**
 * Runtime helpers used by compiled template functions.
 *
 * These functions are bundled into every compiled template or imported from
 * this module at runtime, depending on the compile target.
 */

// ---------------------------------------------------------------------------
// HTML escaping
// ---------------------------------------------------------------------------

const ESCAPE_MAP: Readonly<Record<string, string>> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
  "`": "&#96;",
};

const ESCAPE_REGEX = /[&<>"'`]/g;

/**
 * Escape a string for safe HTML output.
 * Returns an empty string for null / undefined values.
 */
export function escapeHtml(value: unknown): string {
  if (value === null || value === undefined) return "";
  const str = String(value);
  return str.replace(ESCAPE_REGEX, (ch) => ESCAPE_MAP[ch] ?? ch);
}

/**
 * Coerce any value to a string without escaping.
 * Returns an empty string for null / undefined.
 */
export function toRaw(value: unknown): string {
  if (value === null || value === undefined) return "";
  return String(value);
}

// ---------------------------------------------------------------------------
// Safe property access
// ---------------------------------------------------------------------------

/**
 * Safely access a nested property path on an object.
 * Returns undefined if any intermediate value is null / undefined.
 *
 * In strict mode throws a ReferenceError when the resolved value is undefined.
 *
 * @example
 * safeGet(ctx, ["user", "name"], false) // ctx.user?.name
 */
export function safeGet(
  obj: unknown,
  path: readonly string[],
  strict: boolean = false
): unknown {
  let current: unknown = obj;
  for (const key of path) {
    if (current === null || current === undefined) {
      if (strict) {
        throw new ReferenceError(
          `Template strict mode: property "${key}" is undefined`
        );
      }
      return undefined;
    }
    current = (current as Record<string, unknown>)[key];
  }
  if (strict && current === undefined) {
    throw new ReferenceError(
      `Template strict mode: "${path.join(".")}" resolved to undefined`
    );
  }
  return current;
}

// ---------------------------------------------------------------------------
// Iteration helpers
// ---------------------------------------------------------------------------

export interface LoopMeta {
  /** 0-based index */
  index: number;
  /** 1-based index */
  index1: number;
  /** true on first iteration */
  first: boolean;
  /** true on last iteration */
  last: boolean;
  /** total number of items */
  length: number;
}

/**
 * Iterate over any iterable or array-like value, invoking `callback` for each
 * item with loop metadata.
 *
 * Each callback must return the rendered string fragment for that iteration.
 * The accumulated result is returned as a single string.
 */
export function forEach<T>(
  iterable: unknown,
  callback: (item: T, meta: LoopMeta) => string
): string {
  const items = toArray<T>(iterable);
  const length = items.length;
  const parts: string[] = [];
  for (let i = 0; i < length; i++) {
    const item = items[i] as T;
    parts.push(
      callback(item, {
        index: i,
        index1: i + 1,
        first: i === 0,
        last: i === length - 1,
        length,
      })
    );
  }
  return parts.join("");
}

function toArray<T>(value: unknown): T[] {
  if (Array.isArray(value)) return value as T[];
  if (value === null || value === undefined) return [];
  if (typeof value === "object" && Symbol.iterator in (value as object)) {
    return Array.from(value as Iterable<T>);
  }
  return [];
}

// ---------------------------------------------------------------------------
// String buffer
// ---------------------------------------------------------------------------

/**
 * A simple mutable string builder used by compiled templates to accumulate
 * output without repeated string concatenation.
 */
export class StringBuffer {
  private readonly parts: string[] = [];

  append(value: string): this {
    this.parts.push(value);
    return this;
  }

  toString(): string {
    return this.parts.join("");
  }
}

// ---------------------------------------------------------------------------
// Runtime context
// ---------------------------------------------------------------------------

/**
 * Runtime execution context passed to every compiled template function.
 * Provides access to escape helpers, raw output, the string buffer class,
 * and the forEach iterator.
 */
export interface RuntimeContext {
  /** Escape and return a string value (HTML-safe) */
  escape: (value: unknown) => string;
  /** Return a raw (unescaped) string value */
  raw: (value: unknown) => string;
  /** StringBuffer constructor — used for nested buffers in for-loops */
  StringBuffer: typeof StringBuffer;
  /** forEach iterator */
  forEach: typeof forEach;
}

/**
 * Create a fresh {@link RuntimeContext}.
 */
export function createRuntimeContext(escape: boolean): RuntimeContext {
  const escapeFn = escape
    ? (value: unknown): string => escapeHtml(value)
    : (value: unknown): string => toRaw(value);

  return {
    escape: escapeFn,
    raw: toRaw,
    StringBuffer,
    forEach,
  };
}
