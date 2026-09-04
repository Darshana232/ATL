/**
 * The signing scheme.
 *
 * Every test here answers "what forgery does this prevent?" - a signature
 * implementation with only happy-path tests proves nothing at all, because the
 * happy path is identical whether or not the check actually works.
 */
import { describe, expect, it } from 'vitest';
import { generateKeyPairSync } from 'node:crypto';
import {
  buildSigningString,
  checkFreshness,
  hashBody,
  signRequest,
  SIGNING_SCHEME,
  TIMESTAMP_TOLERANCE_MS,
  verifySignature,
} from './signing.js';

function keypair() {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  return {
    publicKeySpkiB64: publicKey.export({ type: 'spki', format: 'der' }).toString('base64'),
    privateKeyPkcs8B64: privateKey.export({ type: 'pkcs8', format: 'der' }).toString('base64'),
  };
}

const body = JSON.stringify({ mandateId: 'mnd_x', amountPaise: 124_000 });

function parts(overrides: Partial<Parameters<typeof buildSigningString>[0]> = {}) {
  return {
    method: 'POST',
    path: '/v1/authorize',
    timestamp: '2026-09-05T14:22:03.000Z',
    keyId: 'akid_grocery_shopper_v1',
    idempotencyKey: 'ord_7f3a91c4',
    bodySha256: hashBody(body),
    ...overrides,
  };
}

describe('the signing string', () => {
  it('starts with the scheme version', () => {
    // A future ATL-v2 signature can then never be mistaken for a v1 one.
    expect(buildSigningString(parts()).split('\n')[0]).toBe(SIGNING_SCHEME);
  });

  it('puts every field on its own line', () => {
    expect(buildSigningString(parts()).split('\n')).toHaveLength(7);
  });

  it('is not vulnerable to field-splitting ambiguity', () => {
    // WHAT: two different requests must never produce the same signing string.
    // WHY:  concatenated without separators, keyId "ab" + key "cd" and
    //       keyId "a" + key "bcd" are the same bytes - so ONE signature would
    //       authorise TWO different requests.
    const a = buildSigningString(parts({ keyId: 'akid_ab', idempotencyKey: 'cd012345' }));
    const b = buildSigningString(parts({ keyId: 'akid_a', idempotencyKey: 'bcd012345' }));

    expect(a).not.toBe(b);
  });

  it('normalises the method to upper case on both sides', () => {
    expect(buildSigningString(parts({ method: 'post' })))
      .toBe(buildSigningString(parts({ method: 'POST' })));
  });
});

describe('verification accepts exactly what it should', () => {
  it('accepts a genuine signature', () => {
    const { publicKeySpkiB64, privateKeyPkcs8B64 } = keypair();
    const signature = signRequest(privateKeyPkcs8B64, parts());

    expect(verifySignature(publicKeySpkiB64, buildSigningString(parts()), signature)).toBe(true);
  });
});

describe('verification rejects every forgery we could think of', () => {
  const { publicKeySpkiB64, privateKeyPkcs8B64 } = keypair();
  const signature = signRequest(privateKeyPkcs8B64, parts());

  it('rejects a tampered body - one paisa is enough', () => {
    // PREVENTS: an attacker intercepting a legitimate ₹1,240 authorization and
    // turning it into ₹99,999 while keeping the signature.
    const tampered = JSON.stringify({ mandateId: 'mnd_x', amountPaise: 124_001 });
    const forged = buildSigningString(parts({ bodySha256: hashBody(tampered) }));

    expect(verifySignature(publicKeySpkiB64, forged, signature)).toBe(false);
  });

  it('rejects a changed path', () => {
    const forged = buildSigningString(parts({ path: '/v1/authorize/admin' }));
    expect(verifySignature(publicKeySpkiB64, forged, signature)).toBe(false);
  });

  it('rejects a changed method', () => {
    const forged = buildSigningString(parts({ method: 'DELETE' }));
    expect(verifySignature(publicKeySpkiB64, forged, signature)).toBe(false);
  });

  it('rejects a changed idempotency key', () => {
    // This one matters twice over: the idempotency key is also our nonce, so a
    // replay attacker who could change it freely could bypass replay detection.
    const forged = buildSigningString(parts({ idempotencyKey: 'ord_different' }));
    expect(verifySignature(publicKeySpkiB64, forged, signature)).toBe(false);
  });

  it('rejects a changed timestamp', () => {
    const forged = buildSigningString(parts({ timestamp: '2026-09-05T19:00:00.000Z' }));
    expect(verifySignature(publicKeySpkiB64, forged, signature)).toBe(false);
  });

  it("rejects another agent's key - the signature does not verify", () => {
    // PREVENTS: agent B signing a request and presenting agent A's key id.
    const other = keypair();
    expect(verifySignature(other.publicKeySpkiB64, buildSigningString(parts()), signature))
      .toBe(false);
  });

  it('returns false rather than throwing on malformed input', () => {
    // WHY IT MATTERS: a security check that throws has an outcome determined by
    // the caller's catch block. These must all be plain, boring `false`.
    const s = buildSigningString(parts());

    expect(verifySignature(publicKeySpkiB64, s, 'not base64 @@@@')).toBe(false);
    expect(verifySignature(publicKeySpkiB64, s, '')).toBe(false);
    expect(verifySignature(publicKeySpkiB64, s, 'AAAA')).toBe(false);          // wrong length
    expect(verifySignature('garbage', s, signature)).toBe(false);              // bad key
    expect(verifySignature('', s, signature)).toBe(false);
    expect(verifySignature(publicKeySpkiB64, s, 'A'.repeat(88))).toBe(false);  // 66 bytes
  });

  it('rejects a signature of the right length but wrong content', () => {
    const s = buildSigningString(parts());
    expect(verifySignature(publicKeySpkiB64, s, Buffer.alloc(64).toString('base64'))).toBe(false);
  });
});

describe('freshness bounds how long a captured request stays usable', () => {
  const now = new Date('2026-09-05T14:22:03.000Z');

  it('accepts a timestamp equal to now', () => {
    expect(checkFreshness(now.toISOString(), now).ok).toBe(true);
  });

  it('accepts the exact tolerance boundary in both directions', () => {
    const old = new Date(now.getTime() - TIMESTAMP_TOLERANCE_MS).toISOString();
    const future = new Date(now.getTime() + TIMESTAMP_TOLERANCE_MS).toISOString();

    expect(checkFreshness(old, now).ok).toBe(true);
    expect(checkFreshness(future, now).ok).toBe(true);
  });

  it('rejects one millisecond past the boundary', () => {
    const old = new Date(now.getTime() - TIMESTAMP_TOLERANCE_MS - 1).toISOString();
    const future = new Date(now.getTime() + TIMESTAMP_TOLERANCE_MS + 1).toISOString();

    expect(checkFreshness(old, now)).toEqual({ ok: false, why: 'too_old' });
    expect(checkFreshness(future, now)).toEqual({ ok: false, why: 'too_new' });
  });

  it('rejects a far-future timestamp, not only an old one', () => {
    // PREVENTS: an attacker minting a request dated 2030 that stays replayable
    // for years. Rejecting only "too old" would allow exactly that.
    expect(checkFreshness('2030-01-01T00:00:00Z', now).ok).toBe(false);
  });

  it('rejects a malformed timestamp instead of treating it as epoch', () => {
    // new Date('nonsense') yields Invalid Date rather than throwing - a real
    // JavaScript footgun, and without the explicit NaN check this would become
    // NaN arithmetic that silently compares false.
    for (const bad of ['nonsense', '', '2026-13-45T99:99:99Z', 'null']) {
      expect(checkFreshness(bad, now), bad).toEqual({ ok: false, why: 'malformed' });
    }
  });
});
