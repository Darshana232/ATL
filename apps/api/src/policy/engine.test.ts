/**
 * The engine: aggregation, precedence, determinism, replay.
 */
import { describe, expect, it } from 'vitest';
import { toPaise } from '../money.js';
import { createMandateTerms, type Mandate, type MandateVersion } from '../domain/mandate.js';
import { ENGINE_VERSION, evaluate } from './engine.js';
import { ALL_RULES } from './rules.js';
import type { EvaluationInput } from './types.js';

const activeMandate: Mandate = {
  id: 'mnd_test',
  userId: 'usr_test',
  agentId: 'agt_test',
  label: 'Weekly groceries',
  status: 'active',
  revokedAt: null,
  revokedBy: null,
  revokedReason: null,
  createdAt: new Date('2026-09-01T00:00:00Z'),
};

const testVersion: MandateVersion = {
  mandateId: 'mnd_test',
  version: 1,
  terms: createMandateTerms({
    perTxnLimitPaise: 200_000,
    windowLimitPaise: 500_000,
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
  }),
  merchantAllowlist: ['mer_bigbasket'],
  createdAt: new Date('2026-09-01T00:00:00Z'),
  createdBy: 'test',
  changeReason: null,
  consentRef: 'consent_test',
  consentAt: new Date('2026-09-01T00:00:00Z'),
};

/** Monday 2026-09-07, 14:22 IST. */
const INSIDE_WINDOW = new Date('2026-09-07T08:52:00Z');

function input(overrides: Partial<EvaluationInput> = {}): EvaluationInput {
  return {
    mandate: activeMandate,
    version: testVersion,
    attempt: {
      agentId: 'agt_test',
      amountPaise: toPaise(124_000),
      merchantId: 'mer_bigbasket',
      merchantMcc: '5411',
      paymentMethod: 'upi_reserve_pay',
    },
    spend: {
      windowStart: new Date('2026-09-07T00:00:00Z'),
      windowEnd: new Date('2026-09-14T00:00:00Z'),
      spentInWindowPaise: toPaise(310_000),
      txnsInLastHour: 2,
    },
    now: INSIDE_WINDOW,
    risk: null,
    ...overrides,
  };
}

describe('the happy path', () => {
  it('authorizes a compliant request', () => {
    const decision = evaluate(input());

    expect(decision.verdict).toBe('PASS');
    expect(decision.reason).toMatch(/all \d+ applicable policy checks passed/);
    expect(decision.engineVersion).toBe(ENGINE_VERSION);
  });
});

describe('EVERY rule runs, even after one has blocked', () => {
  it('returns one evaluation per rule regardless of the verdict', () => {
    // Short-circuiting would leave the audit record unable to show that the
    // other checks were PERFORMED - and "did you check the merchant?" is
    // exactly what an auditor asks.
    const blocked = evaluate(
      input({ attempt: { ...input().attempt, amountPaise: toPaise(620_000) } }),
    );

    expect(blocked.verdict).toBe('BLOCK');
    expect(blocked.evaluations).toHaveLength(ALL_RULES.length);
  });

  it('still evaluates rules that come AFTER the blocking one', () => {
    const blocked = evaluate(
      input({ attempt: { ...input().attempt, amountPaise: toPaise(620_000) } }),
    );

    // MANDATE_PER_TXN_LIMIT is rule 4; these run later and must still report.
    const codes = blocked.evaluations.map((item) => item.ruleCode);
    expect(codes).toContain('MERCHANT_ALLOWLIST');
    expect(codes).toContain('TIME_WINDOW');
    expect(codes).toContain('VELOCITY_LIMIT');
    expect(codes).toContain('RISK_SIGNAL');

    const merchant = blocked.evaluations.find((i) => i.ruleCode === 'MERCHANT_ALLOWLIST');
    expect(merchant?.verdict).toBe('PASS'); // genuinely evaluated, not defaulted
  });

  it('keeps evaluations in declared execution order', () => {
    const sequences = evaluate(input()).evaluations.map((item) => item.sequence);

    expect(sequences).toEqual([...sequences].sort((a, b) => a - b));
  });

  it('gives every rule a distinct code and sequence', () => {
    const evaluations = evaluate(input()).evaluations;

    expect(new Set(evaluations.map((i) => i.ruleCode)).size).toBe(evaluations.length);
    expect(new Set(evaluations.map((i) => i.sequence)).size).toBe(evaluations.length);
  });
});

describe('verdict precedence', () => {
  it('BLOCK beats FLAG', () => {
    const decision = evaluate(
      input({
        attempt: { ...input().attempt, amountPaise: toPaise(620_000) },
        risk: { provider: 'mock', score: 95, band: 'HIGH', reasons: ['suspicious'] },
      }),
    );

    expect(decision.verdict).toBe('BLOCK');
  });

  it('FLAG beats PASS', () => {
    const decision = evaluate(
      input({ risk: { provider: 'mock', score: 91, band: 'HIGH', reasons: ['odd pattern'] } }),
    );

    expect(decision.verdict).toBe('FLAG');
    expect(decision.reason).toContain('odd pattern');
  });

  it('a risk signal can never rescue a BLOCK', () => {
    // Risk is advisory in both directions: it cannot block, and it cannot
    // authorise something a deterministic rule refused.
    const decision = evaluate(
      input({
        attempt: { ...input().attempt, merchantId: 'mer_amazon_in' },
        risk: { provider: 'mock', score: 0, band: 'LOW', reasons: ['perfectly safe'] },
      }),
    );

    expect(decision.verdict).toBe('BLOCK');
  });

  it('SKIP never contributes to the verdict', () => {
    const decision = evaluate(input({ risk: null }));

    expect(decision.evaluations.some((i) => i.verdict === 'SKIP')).toBe(true);
    expect(decision.verdict).toBe('PASS');
  });
});

describe('the headline reason', () => {
  it('names the FIRST blocking rule, not an incidental one', () => {
    // A revoked mandate ALSO fails the time window here (Sunday), but the
    // headline must be the most fundamental failure.
    const decision = evaluate(
      input({
        mandate: {
          ...activeMandate,
          status: 'revoked',
          revokedAt: new Date('2026-09-05T00:00:00Z'),
          revokedBy: 'usr_test',
          revokedReason: 'user withdrew consent',
        },
        now: new Date('2026-09-13T08:52:00Z'), // Sunday - also outside the window
      }),
    );

    expect(decision.verdict).toBe('BLOCK');
    expect(decision.reason).toMatch(/revoked/i);
    expect(decision.reason).not.toMatch(/outside the permitted window/i);
  });

  it('contains the numbers, not just a category', () => {
    const decision = evaluate(
      input({ attempt: { ...input().attempt, amountPaise: toPaise(620_000) } }),
    );

    expect(decision.reason).toContain('₹6,200.00');
    expect(decision.reason).toContain('₹2,000.00');
    expect(decision.reason).toContain('₹4,200.00');
  });

  it('explains a window breach in terms of what was already spent', () => {
    const decision = evaluate(
      input({
        attempt: { ...input().attempt, amountPaise: toPaise(200_000) },
        spend: { ...input().spend, spentInWindowPaise: toPaise(400_000) },
      }),
    );

    expect(decision.verdict).toBe('BLOCK');
    expect(decision.reason).toContain('₹4,000.00'); // already spent
    expect(decision.reason).toContain('₹5,000.00'); // the limit
  });
});

describe('determinism and replay', () => {
  it('produces an identical result for identical inputs', () => {
    const first = evaluate(input());
    const second = evaluate(input());

    expect(JSON.stringify(second)).toBe(JSON.stringify(first));
  });

  it('reads NO clock - the verdict depends only on the `now` passed in', () => {
    // The same request evaluated at two different moments gives two different
    // answers, and neither consults the system clock. That is what makes a
    // past decision replayable.
    const insideWindow = evaluate(input({ now: INSIDE_WINDOW }));
    const outsideWindow = evaluate(input({ now: new Date('2026-09-07T20:00:00Z') })); // 01:30 IST

    expect(insideWindow.verdict).toBe('PASS');
    expect(outsideWindow.verdict).toBe('BLOCK');
  });

  it('echoes `now` as evaluatedAt rather than stamping the current time', () => {
    const past = new Date('2026-09-07T08:52:00Z');

    expect(evaluate(input({ now: past })).evaluatedAt.toISOString()).toBe(past.toISOString());
  });

  it('replays a past decision exactly', () => {
    // Feed the same inputs back in - as Phase 6 will, to re-explain a decision
    // - and every rule outcome must match.
    const original = evaluate(input());
    const replayed = evaluate(input());

    for (let i = 0; i < original.evaluations.length; i += 1) {
      expect(replayed.evaluations[i]?.ruleCode).toBe(original.evaluations[i]?.ruleCode);
      expect(replayed.evaluations[i]?.verdict).toBe(original.evaluations[i]?.verdict);
      expect(replayed.evaluations[i]?.reason).toBe(original.evaluations[i]?.reason);
    }
  });

  it('does not mutate its input', () => {
    const original = input();
    const snapshot = JSON.stringify(original);

    evaluate(original);

    expect(JSON.stringify(original)).toBe(snapshot);
  });
});

describe('the engine records which rule set decided', () => {
  it('stamps the engine version on every decision', () => {
    // The mandate is versioned; the rules must be too. "Why was this allowed in
    // September?" is unanswerable after the rules change without this.
    expect(evaluate(input()).engineVersion).toBe(ENGINE_VERSION);
  });
});

describe('the demo scenario, end to end', () => {
  it('PASSES ₹1,240 and BLOCKS ₹6,200 against the same mandate', () => {
    const allowed = evaluate(
      input({ attempt: { ...input().attempt, amountPaise: toPaise(124_000) } }),
    );
    const refused = evaluate(
      input({ attempt: { ...input().attempt, amountPaise: toPaise(620_000) } }),
    );

    expect(allowed.verdict).toBe('PASS');
    expect(refused.verdict).toBe('BLOCK');
    expect(refused.reason).toContain('₹4,200.00');

    // And both produce a complete, auditable breakdown.
    expect(allowed.evaluations).toHaveLength(ALL_RULES.length);
    expect(refused.evaluations).toHaveLength(ALL_RULES.length);
  });
});
