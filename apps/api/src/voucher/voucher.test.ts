/**
 * The voucher.
 *
 * The claim being proven here is the whole thesis of the project: a token that
 * permits exactly one payment, that nobody can edit, and that expires. Each
 * test names the forgery it prevents.
 */
import { describe, expect, it } from 'vitest';
import { createHmac } from 'node:crypto';
import {
  mintVoucher,
  verifyVoucher,
  voucherJtiFor,
  VOUCHER_PREFIX,
  VOUCHER_TTL_MS,
} from './voucher.js';

const SECRET = 'a'.repeat(64);
const OTHER_SECRET = 'b'.repeat(64);
const NOW = new Date('2026-09-05T14:22:03.000Z');

function mint(overrides: Partial<Parameters<typeof mintVoucher>[1]> = {}) {
  return mintVoucher(SECRET, {
    decisionId: 'dec_abc123',
    mandateId: 'mnd_weekly_groceries',
    agentId: 'agt_grocery_shopper',
    merchantId: 'mer_bigbasket',
    amountPaise: 124_000,
    verdict: 'PASS',
    now: NOW,
    ...overrides,
  });
}

/** Rebuild a token with edited claims, keeping the ORIGINAL signature. */
function tamper(token: string, edit: (claims: Record<string, unknown>) => void): string {
  const [prefix, payload, mac] = token.split('.') as [string, string, string];
  const claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as Record<string, unknown>;
  edit(claims);
  const forged = Buffer.from(JSON.stringify(claims)).toString('base64url');
  return `${prefix}.${forged}.${mac}`;
}

describe('minting', () => {
  it('produces a three-part versioned token', () => {
    const { token } = mint();
    const parts = token.split('.');

    expect(parts).toHaveLength(3);
    expect(parts[0]).toBe(VOUCHER_PREFIX);
  });

  it('bakes every constraint the engine checked into the claims', () => {
    // WHY: this is what makes it a CAPABILITY rather than an identity. A stolen
    // voucher permits one specific payment, not "payments".
    const { claims } = mint();

    expect(claims.mandateId).toBe('mnd_weekly_groceries');
    expect(claims.merchantId).toBe('mer_bigbasket');
    expect(claims.amountPaise).toBe(124_000);
    expect(claims.agentId).toBe('agt_grocery_shopper');
    expect(claims.decisionId).toBe('dec_abc123');
  });

  it('expires 60 seconds after issue', () => {
    const { claims } = mint();
    expect(claims.exp - claims.iat).toBe(VOUCHER_TTL_MS);
  });

  it('derives the same jti for the same decision, every time', () => {
    // WHY IT MATTERS: an idempotent replay must not mint a SECOND spendable
    // token. One jti per decision means payments.voucher_jti UNIQUE caps the
    // whole decision at one payment however many times it is retried.
    expect(mint().claims.jti).toBe(mint().claims.jti);
    expect(voucherJtiFor('dec_abc123')).toBe(mint().claims.jti);
  });

  it('derives different jtis for different decisions', () => {
    expect(voucherJtiFor('dec_one')).not.toBe(voucherJtiFor('dec_two'));
  });

  it('does not leak the decision id into the jti', () => {
    expect(voucherJtiFor('dec_abc123')).not.toContain('abc123');
  });

  it('produces a jti that satisfies the payments table constraint', () => {
    // payments_voucher_jti_shape: length BETWEEN 16 AND 128.
    const { jti } = mint().claims;
    expect(jti.length).toBeGreaterThanOrEqual(16);
    expect(jti.length).toBeLessThanOrEqual(128);
  });
});

describe('verification accepts a genuine voucher', () => {
  it('accepts its own token', () => {
    const { token } = mint();
    const result = verifyVoucher(SECRET, token, NOW);

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.claims.amountPaise).toBe(124_000);
  });

  it('accepts one millisecond before expiry', () => {
    const { token, claims } = mint();
    expect(verifyVoucher(SECRET, token, new Date(claims.exp - 1)).ok).toBe(true);
  });
});

describe('verification rejects every attack we could think of', () => {
  it('rejects an edited amount', () => {
    // PREVENTS: an agent authorised for ₹1,240 capturing ₹99,999.
    const forged = tamper(mint().token, (c) => { c.amountPaise = 9_999_900; });
    expect(verifyVoucher(SECRET, forged, NOW)).toEqual({ ok: false, why: 'bad_signature' });
  });

  it('rejects an edited merchant', () => {
    // PREVENTS: spending a grocery authorisation at a liquor store.
    const forged = tamper(mint().token, (c) => { c.merchantId = 'mer_city_wines'; });
    expect(verifyVoucher(SECRET, forged, NOW).ok).toBe(false);
  });

  it('rejects an extended expiry', () => {
    // PREVENTS: turning a 60-second token into a permanent one.
    const forged = tamper(mint().token, (c) => { c.exp = Number(c.exp) + 86_400_000; });
    expect(verifyVoucher(SECRET, forged, NOW).ok).toBe(false);
  });

  it('rejects an upgraded verdict', () => {
    // A FLAG voucher must not become a PASS voucher.
    const forged = tamper(mint({ verdict: 'FLAG' }).token, (c) => { c.verdict = 'PASS'; });
    expect(verifyVoucher(SECRET, forged, NOW).ok).toBe(false);
  });

  it('rejects a token signed with a different secret', () => {
    // PREVENTS: another deployment's - or an attacker's - tokens being accepted.
    const foreign = mintVoucher(OTHER_SECRET, {
      decisionId: 'dec_abc123', mandateId: 'mnd_x', agentId: 'agt_x',
      merchantId: 'mer_x', amountPaise: 1, verdict: 'PASS', now: NOW,
    });
    expect(verifyVoucher(SECRET, foreign.token, NOW)).toEqual({ ok: false, why: 'bad_signature' });
  });

  it('rejects an expired voucher, exactly at exp', () => {
    const { token, claims } = mint();
    expect(verifyVoucher(SECRET, token, new Date(claims.exp))).toEqual({ ok: false, why: 'expired' });
  });

  it('rejects a voucher one second past expiry', () => {
    const { token, claims } = mint();
    expect(verifyVoucher(SECRET, token, new Date(claims.exp + 1_000)).ok).toBe(false);
  });

  it('rejects a voucher from a badly skewed future clock', () => {
    const { token } = mint();
    expect(verifyVoucher(SECRET, token, new Date(NOW.getTime() - 10 * 60_000)))
      .toEqual({ ok: false, why: 'not_yet_valid' });
  });

  it('rejects a wrong version prefix', () => {
    const { token } = mint();
    const [, payload, mac] = token.split('.') as [string, string, string];

    expect(verifyVoucher(SECRET, `atlv2.${payload}.${mac}`, NOW))
      .toEqual({ ok: false, why: 'wrong_version' });
  });

  it('returns a result rather than throwing on malformed input', () => {
    for (const bad of ['', '.', 'a.b', 'a.b.c.d', 'atlv1..', 'atlv1.@@@.@@@', 'garbage']) {
      const result = verifyVoucher(SECRET, bad, NOW);
      expect(result.ok, `"${bad}" must not verify`).toBe(false);
    }
  });

  it('rejects a token whose payload is valid base64 but not a voucher', () => {
    // Signed correctly but with the wrong shape - the defence against our own
    // older, buggier code, not against an attacker.
    const payload = Buffer.from(JSON.stringify({ hello: 'world' })).toString('base64url');
    const mac = createHmac('sha256', SECRET).update(`atlv1.${payload}`).digest().toString('base64url');

    expect(verifyVoucher(SECRET, `atlv1.${payload}.${mac}`, NOW))
      .toEqual({ ok: false, why: 'claims_unreadable' });
  });
});
