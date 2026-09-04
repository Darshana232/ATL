/**
 * The payment voucher: the single most important object in this system.
 *
 * On PASS (or FLAG) the authorization endpoint mints one. From Phase 7 the
 * payment service REFUSES TO CAPTURE MONEY WITHOUT ONE. That refusal is what
 * turns "the LLM cannot pay" from a promise into a structural fact: an agent -
 * even a fully prompt-injected one - can only ask, and asking goes through code
 * it does not control.
 *
 * IT IS A CAPABILITY TOKEN, NOT AN IDENTITY TOKEN.
 *
 *   identity   "I am agent X"           -> useful for any number of actions
 *   capability "the bearer may capture  -> useful for exactly ONE action
 *               ₹1,240 at mer_bigbasket
 *               once, before 14:23:03"
 *
 * Every constraint the engine checked is baked into the MAC. Changing the
 * amount, the merchant or the mandate invalidates it. A stolen voucher permits
 * only the payment that was already approved.
 *
 * SYMMETRIC (HMAC-SHA256) ON PURPOSE. We mint it and we verify it - one party
 * on both ends - so a shared secret is the simplest thing that works.
 * Asymmetric signing would buy nothing here. Compare auth/signing.ts, where the
 * two parties are different and asymmetric is mandatory.
 *
 * PRODUCTION IMPLICATION: this becomes an asymmetrically signed token with the
 * private key in an HSM/KMS, so a compromised payment service can verify
 * vouchers but not mint them. The architecture does not change (ADR-0008).
 */
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';

/** Prefix and version. A future v2 token can never be read as a v1 token. */
export const VOUCHER_PREFIX = 'atlv1';

/**
 * Sixty seconds.
 *
 * Short because the legitimate gap between "authorized" and "captured" is one
 * network call. Long enough to survive a slow payment provider and a little
 * clock skew. Every extra second is extra time a leaked voucher is spendable.
 */
export const VOUCHER_TTL_MS = 60_000;

export interface VoucherClaims {
  /** Unique token id. UNIQUE in `payments`, which is what makes it single-use. */
  readonly jti: string;
  readonly decisionId: string;
  readonly mandateId: string;
  readonly agentId: string;
  readonly merchantId: string;
  readonly amountPaise: number;
  readonly verdict: 'PASS' | 'FLAG';
  /** Epoch milliseconds. */
  readonly iat: number;
  readonly exp: number;
}

/**
 * The token id is DERIVED from the decision id, not random.
 *
 * WHY: an idempotent replay must not mint a second spendable token. Deriving it
 * means every voucher for a given decision shares one jti, so
 * `payments.voucher_jti UNIQUE` caps the whole decision at one payment no
 * matter how many times the request is retried or replayed.
 *
 * It is a hash rather than the decision id itself so the token does not leak an
 * internal identifier to anyone who intercepts it.
 *
 * 32 hex characters satisfies `payments_voucher_jti_shape` (16-128).
 */
export function voucherJtiFor(decisionId: string): string {
  return createHash('sha256').update(`atl-voucher-jti:${decisionId}`).digest('hex').slice(0, 32);
}

function b64url(input: Buffer | string): string {
  return Buffer.from(input as never).toString('base64url');
}

function macOf(secret: string, signedPart: string): Buffer {
  return createHmac('sha256', secret).update(signedPart).digest();
}

export interface MintParams {
  readonly decisionId: string;
  readonly mandateId: string;
  readonly agentId: string;
  readonly merchantId: string;
  readonly amountPaise: number;
  readonly verdict: 'PASS' | 'FLAG';
  /** Passed in, never read from the clock - the project-wide discipline. */
  readonly now: Date;
  readonly ttlMs?: number;
}

/** `atlv1.<base64url claims>.<base64url hmac>` */
export function mintVoucher(secret: string, params: MintParams): { token: string; claims: VoucherClaims } {
  const iat = params.now.getTime();

  const claims: VoucherClaims = {
    jti: voucherJtiFor(params.decisionId),
    decisionId: params.decisionId,
    mandateId: params.mandateId,
    agentId: params.agentId,
    merchantId: params.merchantId,
    amountPaise: params.amountPaise,
    verdict: params.verdict,
    iat,
    exp: iat + (params.ttlMs ?? VOUCHER_TTL_MS),
  };

  const payload = b64url(JSON.stringify(claims));
  const signedPart = `${VOUCHER_PREFIX}.${payload}`;

  return { token: `${signedPart}.${b64url(macOf(secret, signedPart))}`, claims };
}

export type VoucherFailure =
  | 'malformed'
  | 'wrong_version'
  | 'bad_signature'
  | 'expired'
  | 'not_yet_valid'
  | 'claims_unreadable';

export type VoucherResult =
  | { readonly ok: true; readonly claims: VoucherClaims }
  | { readonly ok: false; readonly why: VoucherFailure };

/**
 * Verify a voucher. Returns a result; never throws.
 *
 * ORDER MATTERS AND IS A SECURITY PROPERTY: the MAC is checked BEFORE the
 * claims are parsed or trusted. Reading `exp` out of an unverified token and
 * acting on it would mean trusting attacker-controlled JSON. Authenticate
 * first, interpret second - the same rule as the request signature.
 *
 * Single-use is NOT checked here and cannot be: it is not a property of the
 * token, it is a property of the world. It is enforced at redemption by
 * `payments.voucher_jti UNIQUE`, because an application-level "have we seen
 * this jti?" loses the race that a unique index wins.
 */
export function verifyVoucher(secret: string, token: string, now: Date): VoucherResult {
  const parts = token.split('.');
  if (parts.length !== 3) return { ok: false, why: 'malformed' };

  const [prefix, payload, mac] = parts as [string, string, string];
  if (prefix !== VOUCHER_PREFIX) return { ok: false, why: 'wrong_version' };
  if (payload === '' || mac === '') return { ok: false, why: 'malformed' };

  const expected = macOf(secret, `${prefix}.${payload}`);
  const provided = Buffer.from(mac, 'base64url');

  // timingSafeEqual throws on a length mismatch, so the length is compared
  // first - and a wrong length is already a definitive failure.
  if (provided.length !== expected.length) return { ok: false, why: 'bad_signature' };
  if (!timingSafeEqual(provided, expected)) return { ok: false, why: 'bad_signature' };

  let claims: VoucherClaims;
  try {
    claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as VoucherClaims;
  } catch {
    return { ok: false, why: 'claims_unreadable' };
  }

  // Shape check even after a valid MAC: a token we minted with an older, buggy
  // version of this code would still verify. Defence against ourselves.
  if (
    typeof claims.jti !== 'string' ||
    typeof claims.decisionId !== 'string' ||
    typeof claims.amountPaise !== 'number' ||
    typeof claims.exp !== 'number' ||
    typeof claims.iat !== 'number'
  ) {
    return { ok: false, why: 'claims_unreadable' };
  }

  if (now.getTime() >= claims.exp) return { ok: false, why: 'expired' };
  // Guards against a token minted by a badly skewed clock being usable for far
  // longer than its TTL suggests.
  if (now.getTime() < claims.iat - VOUCHER_TTL_MS) return { ok: false, why: 'not_yet_valid' };

  return { ok: true, claims };
}
