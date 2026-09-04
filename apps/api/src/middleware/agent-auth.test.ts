/**
 * The header guard, tested where it can actually be observed.
 *
 * WHY THIS FILE EXISTS AT ALL: the first attempt tested duplicate headers
 * through app.inject() and PASSED - because light-my-request collapses repeated
 * headers before Fastify sees them, so the `string[]` branch never ran. A green
 * test that never executes the code it names is worse than no test: it is a
 * false proof. Same class of mistake as PHASE_04's purity check.
 */
import { describe, expect, it } from 'vitest';
import { singleHeader } from './agent-auth.js';

describe('header values are single-line, printable and bounded', () => {
  it('accepts an ordinary header', () => {
    expect(singleHeader('akid_grocery_shopper_v1')).toBe('akid_grocery_shopper_v1');
  });

  it('REJECTS a repeated header rather than resolving it', () => {
    // PREVENTS: request-smuggling shapes, where a proxy and an application
    // disagree about which of two identical headers is authoritative. Two
    // X-ATL-Signature headers is never legitimate, so it is refused outright
    // rather than resolved by picking one.
    expect(singleHeader(['sig-a', 'sig-b'])).toBeNull();
    expect(singleHeader(['sig-a'])).toBeNull();
  });

  it('rejects a header containing a newline', () => {
    // PREVENTS: injecting an extra line into the signing string, which is
    // header injection applied to a signature - the same class of bug as CRLF
    // injection in HTTP.
    expect(singleHeader('idem_abc\nX-ATL-Key: other')).toBeNull();
    expect(singleHeader('idem_abc\r\nfoo')).toBeNull();
  });

  it('rejects control characters, tabs and spaces', () => {
    for (const bad of ['a b', 'a\tb', 'a\u0000b', 'a\u007fb']) {
      expect(singleHeader(bad), JSON.stringify(bad)).toBeNull();
    }
  });

  it('rejects an empty header', () => {
    expect(singleHeader('')).toBeNull();
  });

  it('rejects an over-long header', () => {
    // Cheap denial-of-service control: these values are read and hashed before
    // any other work happens.
    expect(singleHeader('a'.repeat(255))).not.toBeNull();
    expect(singleHeader('a'.repeat(256))).toBeNull();
  });

  it('rejects a non-string', () => {
    for (const bad of [undefined, null, 42, {}, []]) {
      expect(singleHeader(bad)).toBeNull();
    }
  });
});
