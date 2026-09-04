/**
 * Request signing: how an agent proves a request is genuinely its own.
 *
 * ED25519, ASYMMETRIC. The agent holds the private key; we store only the
 * public key (migration 0002). A complete dump of our database therefore
 * contains nothing that can forge a request - there is no secret in it to
 * steal. Compare the voucher (voucher/voucher.ts), which is HMAC: we mint AND
 * verify it, so one shared secret is simpler and asymmetric would buy nothing.
 *
 * Rule of thumb: pick symmetric vs asymmetric by asking WHO NEEDS TO VERIFY.
 *
 * A signature is not encryption. It hides nothing - anyone can read the
 * request. It proves two things: the bytes were not altered in transit, and
 * they were produced by a holder of the private key. Confidentiality is TLS's
 * job.
 */
import { createHash, createPrivateKey, createPublicKey, sign, verify } from 'node:crypto';

/**
 * Scheme version, and it is the FIRST line of every signed string.
 *
 * Including it means a future ATL-v2 signature can never be mistaken for a v1
 * one even if the remaining fields happen to line up - the versions produce
 * different bytes, so they produce different signatures.
 */
export const SIGNING_SCHEME = 'ATL-v1';

export const KEY_HEADER = 'x-atl-key';
export const TIMESTAMP_HEADER = 'x-atl-timestamp';
export const IDEMPOTENCY_HEADER = 'x-atl-idempotency-key';
export const SIGNATURE_HEADER = 'x-atl-signature';

/**
 * How far a request's timestamp may be from our clock, in either direction.
 *
 * WHY IT EXISTS: a signature alone does not stop replay - a captured request
 * stays valid forever. The window bounds how long a stolen request is usable,
 * and (just as important) bounds the set of idempotency keys we would have to
 * remember to detect a replay at all.
 *
 * WHY BOTH DIRECTIONS: clocks drift. A caller 30 seconds ahead of us is not an
 * attacker, and rejecting only "too old" would let an attacker with a
 * far-future timestamp mint a request that stays valid for years.
 *
 * 5 minutes is the same order as AWS SigV4 and Stripe webhook tolerance.
 */
export const TIMESTAMP_TOLERANCE_MS = 5 * 60 * 1000;

export interface SigningParts {
  readonly method: string;
  readonly path: string;
  /** ISO-8601 UTC, exactly as it appears in the header. */
  readonly timestamp: string;
  readonly keyId: string;
  readonly idempotencyKey: string;
  /** Lowercase hex SHA-256 of the RAW request body bytes. */
  readonly bodySha256: string;
}

/**
 * Build the exact bytes both sides sign.
 *
 * TWO DESIGN POINTS, both of which are security properties rather than style:
 *
 * 1. THE BODY IS HASHED, NOT SIGNED DIRECTLY. The signing string stays a fixed
 *    small size no matter how large the cart is, and - more importantly - we
 *    can verify the signature BEFORE parsing JSON. Authenticate first,
 *    interpret second: a parser is a much larger attack surface than a hash.
 *
 * 2. ONE FIELD PER LINE. Concatenated without separators, keyId "ab" plus
 *    idempotency key "cd" and keyId "a" plus "bcd" produce identical bytes, so
 *    a single signature would validate two DIFFERENT requests. That is
 *    field-splitting ambiguity, and a newline separator removes it because
 *    none of these fields may contain a newline (enforced by the header
 *    validation in middleware/agent-auth.ts).
 */
export function buildSigningString(parts: SigningParts): string {
  return [
    SIGNING_SCHEME,
    parts.method.toUpperCase(),
    parts.path,
    parts.timestamp,
    parts.keyId,
    parts.idempotencyKey,
    parts.bodySha256,
  ].join('\n');
}

/** Lowercase hex SHA-256 of raw bytes. */
export function hashBody(body: string | Buffer): string {
  return createHash('sha256').update(body).digest('hex');
}

/**
 * Ed25519 public keys are stored base64 DER SPKI (44 raw bytes -> 60 base64
 * chars). Anything else means a corrupt or wrong-format credential row, and we
 * must treat that as a verification FAILURE rather than an exception that
 * escapes into a 500 - a malformed credential should deny access, not crash
 * the endpoint.
 */
function publicKeyFrom(spkiBase64: string) {
  return createPublicKey({
    key: Buffer.from(spkiBase64, 'base64'),
    format: 'der',
    type: 'spki',
  });
}

/**
 * Verify a signature over the signing string.
 *
 * Returns a boolean and NEVER throws. Every failure mode - malformed base64,
 * wrong key length, corrupt DER, a signature of the wrong size - collapses to
 * `false`. A security check that can throw becomes a check whose outcome
 * depends on the caller's catch block, which is the worst possible place for
 * an authorization decision to live.
 *
 * `crypto.verify` for Ed25519 is constant-time with respect to the signature,
 * so no timingSafeEqual is needed here (unlike the shared-key comparison in
 * middleware/admin-auth.ts).
 */
export function verifySignature(
  publicKeySpkiB64: string,
  signingString: string,
  signatureB64: string,
): boolean {
  try {
    const signature = Buffer.from(signatureB64, 'base64');

    // An Ed25519 signature is exactly 64 bytes. Checking first turns a class of
    // malformed input into a clean false instead of a library exception.
    if (signature.length !== 64) return false;

    return verify(
      null, // Ed25519 selects its own hash; passing an algorithm is an error.
      Buffer.from(signingString, 'utf8'),
      publicKeyFrom(publicKeySpkiB64),
      signature,
    );
  } catch {
    return false;
  }
}

/**
 * Sign, for CLIENTS: our tests, the demo script and the Phase 7 agent runtime.
 *
 * It lives beside the verifier deliberately. If signing and verifying were
 * written from two separate readings of a spec they would eventually disagree
 * about some edge case, and the disagreement would look like an attack.
 */
export function signRequest(privateKeyPkcs8B64: string, parts: SigningParts): string {
  const key = createPrivateKey({
    key: Buffer.from(privateKeyPkcs8B64, 'base64'),
    format: 'der',
    type: 'pkcs8',
  });

  return sign(null, Buffer.from(buildSigningString(parts), 'utf8'), key).toString('base64');
}

export type FreshnessResult =
  | { readonly ok: true; readonly at: Date }
  | { readonly ok: false; readonly why: 'malformed' | 'too_old' | 'too_new' };

/**
 * Is this timestamp inside the tolerance window?
 *
 * `now` is a parameter, not `Date.now()` - the same discipline as the policy
 * engine, so the tolerance can be tested without fake timers.
 */
export function checkFreshness(timestamp: string, now: Date): FreshnessResult {
  const at = new Date(timestamp);

  // `new Date('nonsense')` yields Invalid Date rather than throwing, so an
  // explicit NaN check is required - this is a real JavaScript footgun.
  if (Number.isNaN(at.getTime())) return { ok: false, why: 'malformed' };

  const skew = at.getTime() - now.getTime();

  if (skew < -TIMESTAMP_TOLERANCE_MS) return { ok: false, why: 'too_old' };
  if (skew > TIMESTAMP_TOLERANCE_MS) return { ok: false, why: 'too_new' };

  return { ok: true, at };
}
