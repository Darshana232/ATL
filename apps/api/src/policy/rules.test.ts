/**
 * The rules, one at a time.
 *
 * BOUNDARY VALUES ON EVERY LIMIT: exactly at it, one below, one above. An
 * off-by-one in a spending limit is a real money bug, invisible in review, and
 * appears only at the exact boundary - which is precisely where an attacker
 * probes.
 */
import { describe, expect, it } from 'vitest';
import { toPaise } from '../money.js';
import { createMandateTerms, type Mandate, type MandateVersion } from '../domain/mandate.js';
import {
  afaExemptionThreshold,
  categoryBlocklist,
  mandateExpiry,
  mandateNotYetValid,
  mandateRevoked,
  merchantAllowlist,
  paymentMethodAllowed,
  perTransactionLimit,
  riskSignal,
  timeWindow,
  velocityLimit,
  windowSpendLimit,
} from './rules.js';
import type { EvaluationInput } from './types.js';

const PER_TXN = 200_000; // ₹2,000
const WINDOW = 500_000; // ₹5,000

const activeMandate: Mandate = {
  id: 'mnd_test',
  userId: 'usr_test',
  agentId: 'agt_test',
  label: 'Test',
  status: 'active',
  revokedAt: null,
  revokedBy: null,
  revokedReason: null,
  createdAt: new Date('2026-09-01T00:00:00Z'),
};

function version(overrides: Record<string, unknown> = {}): MandateVersion {
  return {
    mandateId: 'mnd_test',
    version: 1,
    terms: createMandateTerms({
      perTxnLimitPaise: PER_TXN,
      windowLimitPaise: WINDOW,
      windowKind: 'week',
      maxTxnPerHour: 5,
      blockedMccs: ['5921', '7995'],
      timezone: 'Asia/Kolkata',
      windowStartHour: 8,
      windowEndHour: 20,
      allowedWeekdays: ['MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT'],
      validFrom: new Date('2026-09-01T00:00:00Z'),
      validTo: new Date('2026-12-31T23:59:59Z'),
      paymentMethods: ['upi_reserve_pay'],
      ...overrides,
    }),
    merchantAllowlist: ['mer_bigbasket'],
    createdAt: new Date('2026-09-01T00:00:00Z'),
    createdBy: 'test',
    changeReason: null,
    consentRef: 'consent_test',
    consentAt: new Date('2026-09-01T00:00:00Z'),
  };
}

/** Monday 2026-09-07, 14:22 IST - comfortably inside the default window. */
const INSIDE_WINDOW = new Date('2026-09-07T08:52:00Z');

function input(overrides: Partial<EvaluationInput> = {}): EvaluationInput {
  return {
    mandate: activeMandate,
    version: version(),
    attempt: {
      amountPaise: toPaise(124_000),
      merchantId: 'mer_bigbasket',
      merchantMcc: '5411',
      paymentMethod: 'upi_reserve_pay',
    },
    spend: {
      windowStart: new Date('2026-09-07T00:00:00Z'),
      windowEnd: new Date('2026-09-14T00:00:00Z'),
      spentInWindowPaise: toPaise(0),
      txnsInLastHour: 0,
    },
    now: INSIDE_WINDOW,
    risk: null,
    ...overrides,
  };
}

describe('MANDATE_PER_TXN_LIMIT - boundary values', () => {
  const at = (amount: number) =>
    perTransactionLimit(input({ attempt: { ...input().attempt, amountPaise: toPaise(amount) } }));

  it('ALLOWS exactly the limit', () => {
    // `>` not `>=`. A limit of ₹2,000 permits ₹2,000 - the everyday reading.
    expect(at(PER_TXN).verdict).toBe('PASS');
  });

  it('allows one paisa below the limit', () => {
    expect(at(PER_TXN - 1).verdict).toBe('PASS');
  });

  it('BLOCKS one paisa above the limit', () => {
    expect(at(PER_TXN + 1).verdict).toBe('BLOCK');
  });

  it('states the overage in the reason, with numbers', () => {
    const result = at(620_000); // ₹6,200 against ₹2,000

    expect(result.reason).toContain('₹6,200.00');
    expect(result.reason).toContain('₹2,000.00');
    expect(result.reason).toContain('₹4,200.00'); // the overage
  });

  it('carries machine-readable amounts so reports need not parse English', () => {
    const result = at(620_000);

    expect(result.observedPaise).toBe(620_000);
    expect(result.limitPaise).toBe(PER_TXN);
  });
});

describe('MANDATE_WINDOW_LIMIT - boundary values', () => {
  const withSpend = (spent: number, amount: number) =>
    windowSpendLimit(
      input({
        attempt: { ...input().attempt, amountPaise: toPaise(amount) },
        spend: { ...input().spend, spentInWindowPaise: toPaise(spent) },
      }),
    );

  it('ALLOWS a total exactly at the limit', () => {
    expect(withSpend(300_000, 200_000).verdict).toBe('PASS'); // 500,000 exactly
  });

  it('BLOCKS a total one paisa over', () => {
    expect(withSpend(300_000, 200_001).verdict).toBe('BLOCK');
  });

  it('counts what is ALREADY spent, not just this attempt', () => {
    // ₹1,200 alone is well within the per-transaction limit, but not on top of
    // ₹4,000 already spent this week.
    const result = withSpend(400_000, 120_000);

    expect(result.verdict).toBe('BLOCK');
    expect(result.reason).toContain('₹4,000.00');
    expect(result.reason).toContain('₹1,200.00');
  });

  it('reports remaining headroom when it passes', () => {
    expect(withSpend(100_000, 100_000).reason).toContain('₹3,000.00'); // remaining
  });
});

describe('VELOCITY_LIMIT - the operator is >= , deliberately', () => {
  const withCount = (count: number) =>
    velocityLimit(input({ spend: { ...input().spend, txnsInLastHour: count } }));

  it('BLOCKS at exactly the limit', () => {
    // txnsInLastHour counts COMPLETED transactions. If the limit is 5 and 5
    // have completed, this attempt would be the sixth.
    expect(withCount(5).verdict).toBe('BLOCK');
  });

  it('allows one below the limit', () => {
    expect(withCount(4).verdict).toBe('PASS');
  });

  it('allows zero', () => {
    expect(withCount(0).verdict).toBe('PASS');
  });

  it('gets the singular right in the reason', () => {
    const one = velocityLimit(
      input({
        version: version({ maxTxnPerHour: 1 }),
        spend: { ...input().spend, txnsInLastHour: 1 },
      }),
    );

    expect(one.reason).toContain('1 transaction already');
    expect(one.reason).not.toContain('1 transactions');
  });
});

describe('MERCHANT_ALLOWLIST - deny by default', () => {
  it('allows a merchant on the list', () => {
    expect(merchantAllowlist(input()).verdict).toBe('PASS');
  });

  it('blocks a merchant not on the list', () => {
    const result = merchantAllowlist(
      input({ attempt: { ...input().attempt, merchantId: 'mer_amazon_in' } }),
    );

    expect(result.verdict).toBe('BLOCK');
    expect(result.reason).toContain('mer_amazon_in');
  });

  it('BLOCKS EVERY merchant when the allowlist is empty', () => {
    // Empty means no merchant is permitted. Reading it as "no restriction"
    // would turn an unfinished mandate into an unlimited one.
    const result = merchantAllowlist(
      input({ version: { ...version(), merchantAllowlist: [] } }),
    );

    expect(result.verdict).toBe('BLOCK');
    expect(result.reason).toMatch(/empty merchant allowlist/i);
  });
});

describe('CATEGORY_BLOCKLIST - keyed on MCC, not on names', () => {
  it('allows an unblocked category', () => {
    expect(categoryBlocklist(input()).verdict).toBe('PASS'); // 5411 groceries
  });

  it('blocks a blocked category', () => {
    const result = categoryBlocklist(
      input({ attempt: { ...input().attempt, merchantMcc: '5921' } }), // liquor
    );

    expect(result.verdict).toBe('BLOCK');
    expect(result.reason).toContain('5921');
  });

  it('allows everything when nothing is blocked', () => {
    const result = categoryBlocklist(
      input({
        version: version({ blockedMccs: [] }),
        attempt: { ...input().attempt, merchantMcc: '5921' },
      }),
    );

    expect(result.verdict).toBe('PASS');
  });
});

describe('TIME_WINDOW - evaluated in the mandate timezone', () => {
  it('passes inside the window', () => {
    expect(timeWindow(input()).verdict).toBe('PASS');
  });

  it('blocks before the window opens', () => {
    // 02:00 UTC = 07:30 IST, before an 08:00 start.
    expect(timeWindow(input({ now: new Date('2026-09-07T02:00:00Z') })).verdict).toBe('BLOCK');
  });

  it('blocks at exactly the end hour', () => {
    // 14:30 UTC = 20:00 IST. The end hour is exclusive.
    expect(timeWindow(input({ now: new Date('2026-09-07T14:30:00Z') })).verdict).toBe('BLOCK');
  });

  it('passes one minute before the end hour', () => {
    expect(timeWindow(input({ now: new Date('2026-09-07T14:29:00Z') })).verdict).toBe('PASS');
  });

  it('blocks on a day outside the allowed weekdays', () => {
    // 2026-09-13 is a Sunday; the mandate permits MON-SAT.
    expect(timeWindow(input({ now: new Date('2026-09-13T08:52:00Z') })).verdict).toBe('BLOCK');
  });

  it('uses the ZONE-LOCAL weekday, not the UTC one', () => {
    // 2026-09-12T18:30:00Z is Saturday in UTC but SUNDAY in IST. The mandate
    // permits Saturday and refuses Sunday, so a UTC weekday check would
    // wrongly allow this.
    const result = timeWindow(input({ now: new Date('2026-09-12T18:30:00Z') }));

    expect(result.verdict).toBe('BLOCK');
    expect(result.actual).toContain('SUN');
  });

  it('names the timezone in the explanation', () => {
    expect(timeWindow(input()).expected).toContain('Asia/Kolkata');
  });
});

describe('PAYMENT_METHOD_ALLOWED', () => {
  it('allows a permitted method', () => {
    expect(paymentMethodAllowed(input()).verdict).toBe('PASS');
  });

  it('blocks a method the mandate does not permit', () => {
    const result = paymentMethodAllowed(
      input({ attempt: { ...input().attempt, paymentMethod: 'card' } }),
    );

    expect(result.verdict).toBe('BLOCK');
    expect(result.reason).toContain('card');
  });
});

describe('mandate lifecycle rules', () => {
  it('blocks a revoked mandate and says why', () => {
    const result = mandateRevoked(
      input({
        mandate: {
          ...activeMandate,
          status: 'revoked',
          revokedAt: new Date('2026-09-05T00:00:00Z'),
          revokedBy: 'usr_test',
          revokedReason: 'user withdrew consent',
        },
      }),
    );

    expect(result.verdict).toBe('BLOCK');
    expect(result.reason).toContain('user withdrew consent');
    expect(result.reason).toMatch(/permanent/i);
  });

  it('passes an active mandate', () => {
    expect(mandateRevoked(input()).verdict).toBe('PASS');
  });

  it('distinguishes NOT YET VALID from EXPIRED', () => {
    // Collapsing both into "invalid" would make the explanation wrong in one
    // of the two cases - and the reason is the product.
    const early = input({ now: new Date('2026-01-01T00:00:00Z') });
    const late = input({ now: new Date('2027-06-01T00:00:00Z') });

    expect(mandateNotYetValid(early).verdict).toBe('BLOCK');
    expect(mandateExpiry(early).verdict).toBe('PASS');

    expect(mandateExpiry(late).verdict).toBe('BLOCK');
    expect(mandateNotYetValid(late).verdict).toBe('PASS');
  });

  it('treats the exact validity boundaries as inclusive', () => {
    const terms = version().terms;

    expect(mandateExpiry(input({ now: terms.validTo })).verdict).toBe('PASS');
    expect(
      mandateExpiry(input({ now: new Date(terms.validTo.getTime() + 1) })).verdict,
    ).toBe('BLOCK');
    expect(mandateNotYetValid(input({ now: terms.validFrom })).verdict).toBe('PASS');
  });
});

describe('AFA_EXEMPTION_THRESHOLD - informational, never enforcing', () => {
  it('PASSES even far above the threshold', () => {
    // This governs whether the RAIL requires a UPI PIN. We do not operate that
    // rail, so we record and display - we never enforce. The research treats
    // this threshold as a mandate cap; it is not.
    const result = afaExemptionThreshold(
      input({ attempt: { ...input().attempt, amountPaise: toPaise(50_000_000) } }), // ₹5,00,000
    );

    expect(result.verdict).toBe('PASS');
    expect(result.reason).toMatch(/not enforced here/i);
  });

  it('notes when the amount is within the ceiling', () => {
    expect(afaExemptionThreshold(input()).verdict).toBe('PASS');
  });

  it('is a DIFFERENT rule from the mandate limit', () => {
    // ₹50,000 is above the ₹2,000 mandate limit but below the ₹1,00,000 AFA
    // ceiling: one blocks, the other does not. Conflating them would enforce
    // someone else's threshold as if it were ours.
    const attempt = { ...input().attempt, amountPaise: toPaise(5_000_000) };

    expect(perTransactionLimit(input({ attempt })).verdict).toBe('BLOCK');
    expect(afaExemptionThreshold(input({ attempt })).verdict).toBe('PASS');
  });
});

describe('RISK_SIGNAL - advisory only', () => {
  it('SKIPS when no provider answered', () => {
    // SKIP, not PASS: "nobody answered" differs from "a provider said fine".
    expect(riskSignal(input({ risk: null })).verdict).toBe('SKIP');
  });

  it('passes a low score', () => {
    const result = riskSignal(
      input({ risk: { provider: 'mock', score: 12, band: 'LOW', reasons: [] } }),
    );

    expect(result.verdict).toBe('PASS');
  });

  it('FLAGS a high score - and never blocks', () => {
    const result = riskSignal(
      input({
        risk: { provider: 'mock', score: 91, band: 'HIGH', reasons: ['unusual velocity'] },
      }),
    );

    expect(result.verdict).toBe('FLAG');
    expect(result.verdict).not.toBe('BLOCK');
    expect(result.reason).toContain('unusual velocity');
    expect(result.reason).toMatch(/not blocked by this signal/i);
  });

  it('can never produce BLOCK for any band or score', () => {
    for (const band of ['LOW', 'MEDIUM', 'HIGH'] as const) {
      for (const score of [0, 50, 100]) {
        const result = riskSignal(input({ risk: { provider: 'mock', score, band, reasons: [] } }));
        expect(result.verdict).not.toBe('BLOCK');
      }
    }
  });
});
