/**
 * Canonical JSON serialisation, for hashing.
 *
 * THE PROBLEM. `{"a":1,"b":2}` and `{"b":2,"a":1}` are the same object but
 * different BYTES, and a hash is over bytes. If the audit chain hashed raw
 * JSON.stringify output, it would break the day a library reorders keys, or we
 * add a field in a different position, or an engine changes property
 * enumeration - and "the audit trail no longer verifies" is indistinguishable
 * from tampering. A chain that cries wolf is worse than no chain.
 *
 * THE RULES:
 *   - object keys sorted by code unit, recursively
 *   - array order PRESERVED (order is meaningful in an array)
 *   - only JSON-representable values, and nothing ambiguous
 *   - reject rather than coerce: silently dropping a field changes what the
 *     hash covers, which makes the evidence subtly wrong. Refusing is safer
 *     than approximating.
 *
 * Deliberately NOT using JSON.stringify's `replacer`, because it cannot
 * reject - a replacer returning undefined drops the key silently.
 */
import { createHash } from 'node:crypto';

export class CanonicalJsonError extends Error {
  override readonly name = 'CanonicalJsonError';
}

/**
 * Guards against a hostile or accidentally enormous payload. Depth first,
 * because a deeply nested object can blow the stack before size matters.
 */
const MAX_DEPTH = 32;
const MAX_OUTPUT_BYTES = 256 * 1024;

/** Values we accept inside a hashed payload. */
export type CanonicalValue =
  | string
  | number
  | boolean
  | null
  | readonly CanonicalValue[]
  | { readonly [key: string]: CanonicalValue };

function fail(path: string, message: string): never {
  throw new CanonicalJsonError(`${path === '' ? '(root)' : path}: ${message}`);
}

function serialise(value: unknown, path: string, depth: number, seen: WeakSet<object>): string {
  if (depth > MAX_DEPTH) {
    fail(path, `nesting exceeds the maximum depth of ${MAX_DEPTH}`);
  }

  if (value === null) return 'null';

  switch (typeof value) {
    case 'boolean':
      return value ? 'true' : 'false';

    case 'number': {
      // NaN and Infinity have no JSON representation - JSON.stringify turns
      // them into `null`, which would silently change the hashed content.
      if (!Number.isFinite(value)) {
        fail(path, `${String(value)} cannot be represented in JSON`);
      }
      // Normalise -0 to 0. They are distinct numbers but the same value for
      // our purposes, and JSON.stringify(-0) is already "0" - being explicit
      // means the rule is visible rather than incidental.
      return JSON.stringify(value === 0 ? 0 : value) as string;
    }

    case 'string':
      // Delegated on purpose: JSON.stringify implements JSON string escaping
      // (control characters, quotes, backslashes, lone surrogates) correctly,
      // and reimplementing it would be a bug factory.
      return JSON.stringify(value);

    case 'undefined':
      // The single most dangerous case. JSON.stringify DROPS undefined object
      // properties entirely, so a typo'd field would vanish from the hashed
      // evidence with no error at all.
      fail(path, 'undefined is not allowed; omit the key or use null explicitly');

    case 'bigint':
      fail(path, 'bigint cannot be represented in JSON; pass a string or a safe integer');

    case 'function':
    case 'symbol':
      fail(path, `${typeof value} cannot be serialised`);

    default:
      break;
  }

  // --- objects and arrays ------------------------------------------------
  if (typeof value !== 'object') fail(path, 'unsupported value');

  const asObject = value as object;

  // A cycle would recurse forever.
  if (seen.has(asObject)) fail(path, 'circular reference');
  seen.add(asObject);

  try {
    if (Array.isArray(value)) {
      const items = value.map((item, index) =>
        serialise(item, `${path}[${index}]`, depth + 1, seen),
      );
      return `[${items.join(',')}]`;
    }

    // Dates are rejected rather than serialised via toJSON, so the caller has
    // to decide the representation explicitly. Otherwise the hashed bytes
    // depend on a method we do not control.
    if (value instanceof Date) {
      fail(path, 'Date is not allowed; pass an explicit ISO-8601 string');
    }
    if (value instanceof Map || value instanceof Set) {
      fail(path, `${value.constructor.name} is not allowed; pass a plain object or array`);
    }

    const record = value as Record<string, unknown>;

    // SORTED KEYS - the whole point of this module. localeCompare would be
    // locale-dependent; < and > compare UTF-16 code units, which is stable
    // everywhere.
    const keys = Object.keys(record).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));

    const entries = keys.map((key) => {
      const serialisedValue = serialise(
        record[key],
        path === '' ? key : `${path}.${key}`,
        depth + 1,
        seen,
      );
      return `${JSON.stringify(key)}:${serialisedValue}`;
    });

    return `{${entries.join(',')}}`;
  } finally {
    // Allow the same object to appear twice in different branches (which is
    // not a cycle); only reject it on the path to itself.
    seen.delete(asObject);
  }
}

/**
 * Serialise a value to canonical JSON.
 *
 * @throws CanonicalJsonError on anything ambiguous, unrepresentable, cyclic,
 *         too deep, or too large.
 */
export function canonicalJson(value: CanonicalValue): string {
  const output = serialise(value, '', 0, new WeakSet());

  const bytes = Buffer.byteLength(output, 'utf8');
  if (bytes > MAX_OUTPUT_BYTES) {
    // Refuse rather than truncate: truncating changes what the hash covers,
    // producing evidence that verifies but describes something else.
    throw new CanonicalJsonError(
      `serialised payload is ${bytes} bytes, exceeding the ${MAX_OUTPUT_BYTES}-byte limit`,
    );
  }

  return output;
}

/** SHA-256 of a UTF-8 string, lowercase hex. */
export function sha256Hex(input: string): string {
  return createHash('sha256').update(input, 'utf8').digest('hex');
}

/** Canonicalise, then hash. The pairing used everywhere in the audit trail. */
export function hashCanonical(value: CanonicalValue): string {
  return sha256Hex(canonicalJson(value));
}
