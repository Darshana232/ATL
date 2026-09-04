import { describe, expect, it } from 'vitest';
import { CanonicalJsonError, canonicalJson, hashCanonical, sha256Hex } from './canonical.js';

describe('canonicalJson - key order must not affect the bytes', () => {
  it('produces identical output for reordered keys', () => {
    // THE reason this module exists. If these differ, the audit chain breaks
    // the first time anything reorders a key.
    const a = canonicalJson({ a: 1, b: 2, c: 3 });
    const b = canonicalJson({ c: 3, a: 1, b: 2 });
    const c = canonicalJson({ b: 2, c: 3, a: 1 });

    expect(a).toBe(b);
    expect(b).toBe(c);
    expect(a).toBe('{"a":1,"b":2,"c":3}');
  });

  it('sorts keys recursively, at every level', () => {
    const output = canonicalJson({
      outer: { z: 1, a: 2 },
      alpha: { nested: { y: 1, b: 2 } },
    });

    expect(output).toBe('{"alpha":{"nested":{"b":2,"y":1}},"outer":{"a":2,"z":1}}');
  });

  it('sorts by UTF-16 code unit, not by locale', () => {
    // A locale-aware comparison would make the hash depend on the server's
    // locale - the same class of bug as key ordering, but harder to spot.
    const output = canonicalJson({ B: 1, a: 2, A: 3, b: 4 });
    expect(output).toBe('{"A":3,"B":1,"a":2,"b":4}');
  });

  it('PRESERVES array order, because order is meaningful in an array', () => {
    expect(canonicalJson([3, 1, 2])).toBe('[3,1,2]');
    expect(canonicalJson([1, 2, 3])).not.toBe(canonicalJson([3, 2, 1]));
  });
});

describe('canonicalJson - value handling', () => {
  it('handles the JSON primitives', () => {
    expect(canonicalJson(null)).toBe('null');
    expect(canonicalJson(true)).toBe('true');
    expect(canonicalJson(false)).toBe('false');
    expect(canonicalJson(0)).toBe('0');
    expect(canonicalJson(-1)).toBe('-1');
    expect(canonicalJson('hello')).toBe('"hello"');
  });

  it('normalises -0 to 0', () => {
    expect(canonicalJson(-0)).toBe('0');
    expect(canonicalJson(-0)).toBe(canonicalJson(0));
  });

  it('escapes strings correctly, including control characters and unicode', () => {
    expect(canonicalJson('say "hi"')).toBe('"say \\"hi\\""');
    expect(canonicalJson('line\nbreak')).toBe('"line\\nbreak"');
    expect(canonicalJson('back\\slash')).toBe('"back\\\\slash"');
    // Non-ASCII must round-trip stably - Indian-language intent text will
    // routinely appear in audit payloads.
    expect(JSON.parse(canonicalJson('कुछ सब्ज़ियाँ'))).toBe('कुछ सब्ज़ियाँ');
    expect(JSON.parse(canonicalJson('₹4,870'))).toBe('₹4,870');
  });

  it('handles empty containers', () => {
    expect(canonicalJson({})).toBe('{}');
    expect(canonicalJson([])).toBe('[]');
  });

  it('allows the same object in two branches (not a cycle)', () => {
    const shared = { x: 1 };
    expect(canonicalJson({ a: shared, b: shared })).toBe('{"a":{"x":1},"b":{"x":1}}');
  });
});

describe('canonicalJson - rejects rather than coerces', () => {
  it('REJECTS undefined, which JSON.stringify silently drops', () => {
    // The most dangerous case by far. JSON.stringify({a: 1, b: undefined})
    // returns '{"a":1}' - so a typo'd or accidentally-undefined field would
    // vanish from the hashed evidence with no error whatsoever.
    expect(JSON.stringify({ a: 1, b: undefined })).toBe('{"a":1}'); // documents the hazard

    expect(() => canonicalJson({ a: 1, b: undefined } as never)).toThrow(CanonicalJsonError);
    expect(() => canonicalJson({ a: 1, b: undefined } as never)).toThrow(/undefined/);
  });

  it('REJECTS NaN and Infinity, which JSON.stringify turns into null', () => {
    expect(JSON.stringify({ n: NaN })).toBe('{"n":null}'); // documents the hazard

    expect(() => canonicalJson({ n: NaN } as never)).toThrow(CanonicalJsonError);
    expect(() => canonicalJson({ n: Infinity } as never)).toThrow(CanonicalJsonError);
    expect(() => canonicalJson({ n: -Infinity } as never)).toThrow(CanonicalJsonError);
  });

  it('REJECTS a Date, forcing an explicit representation', () => {
    // Otherwise the hashed bytes depend on Date.prototype.toJSON, a method we
    // do not control.
    expect(() => canonicalJson({ at: new Date() } as never)).toThrow(/ISO-8601/);
  });

  it('REJECTS bigint, Map, Set, functions and symbols', () => {
    expect(() => canonicalJson({ n: 1n } as never)).toThrow(/bigint/);
    expect(() => canonicalJson({ m: new Map() } as never)).toThrow(/Map/);
    expect(() => canonicalJson({ s: new Set() } as never)).toThrow(/Set/);
    expect(() => canonicalJson({ f: () => 1 } as never)).toThrow(/function/);
    expect(() => canonicalJson({ s: Symbol('x') } as never)).toThrow(/symbol/);
  });

  it('REJECTS a circular reference instead of recursing forever', () => {
    const cyclic: Record<string, unknown> = { name: 'loop' };
    cyclic.self = cyclic;

    expect(() => canonicalJson(cyclic as never)).toThrow(/circular/);
  });

  it('REJECTS nesting beyond the depth limit', () => {
    let deep: Record<string, unknown> = { end: true };
    for (let i = 0; i < 40; i += 1) deep = { nested: deep };

    expect(() => canonicalJson(deep as never)).toThrow(/depth/);
  });

  it('REJECTS an oversized payload rather than truncating it', () => {
    // Truncating would change what the hash covers, producing evidence that
    // verifies but describes something else.
    const huge = { blob: 'x'.repeat(300 * 1024) };

    expect(() => canonicalJson(huge)).toThrow(/exceeding/);
  });

  it('names the path to the offending value', () => {
    expect(() => canonicalJson({ outer: { inner: [1, NaN] } } as never)).toThrow(
      /outer\.inner\[1\]/,
    );
  });
});

describe('hashing', () => {
  it('sha256Hex produces a known digest', () => {
    // A fixed vector, so a change in hashing is immediately visible.
    expect(sha256Hex('')).toBe(
      'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    );
    expect(sha256Hex('abc')).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
  });

  it('produces the same hash for logically identical objects', () => {
    expect(hashCanonical({ amountPaise: 487050, merchant: 'mer_x' })).toBe(
      hashCanonical({ merchant: 'mer_x', amountPaise: 487050 }),
    );
  });

  it('produces a different hash when any value changes', () => {
    const base = hashCanonical({ amountPaise: 487050 });

    // One paisa's difference must change the digest.
    expect(hashCanonical({ amountPaise: 487051 })).not.toBe(base);
    // As must a type change that looks similar.
    expect(hashCanonical({ amountPaise: '487050' })).not.toBe(base);
  });

  it('is stable for a realistic audit payload', () => {
    // Pinned so that any future change to canonicalisation or hashing breaks
    // this test loudly instead of silently invalidating an existing chain.
    const payload = {
      v: 1,
      mandateId: 'mnd_weekly_groceries',
      version: 3,
      terms: {
        perTxnLimitPaise: 200000,
        windowLimitPaise: 500000,
        windowKind: 'week',
        blockedMccs: ['5921', '7995'],
      },
      consentRef: 'consent_seed_mnd_weekly_groceries_v3',
    };

    expect(hashCanonical(payload)).toBe(hashCanonical(payload));
    expect(canonicalJson(payload)).toMatchInlineSnapshot(
      `"{"consentRef":"consent_seed_mnd_weekly_groceries_v3","mandateId":"mnd_weekly_groceries","terms":{"blockedMccs":["5921","7995"],"perTxnLimitPaise":200000,"windowKind":"week","windowLimitPaise":500000},"v":1,"version":3}"`,
    );
  });
});
