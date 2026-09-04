import { describe, expect, it } from 'vitest';
import {
  DEFAULT_AFA_EXEMPTION_THRESHOLD_PAISE,
  MandateValidationError,
  createMandateTerms,
  isExpiredAt,
  isNotYetValidAt,
  isUsableAt,
  type Mandate,
  type MandateTermsInput,
  type MandateWithVersion,
} from './mandate.js';

/** Valid input. Each test breaks exactly one field. */
const validInput: MandateTermsInput = {
  perTxnLimitPaise: 200_000, // ₹2,000
  windowLimitPaise: 500_000, // ₹5,000
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
};

/** Collect the field names an invalid input complains about. */
function issueFields(input: MandateTermsInput): string[] {
  try {
    createMandateTerms(input);
    return [];
  } catch (error) {
    if (error instanceof MandateValidationError) {
      return error.issues.map((issue) => issue.field);
    }
    throw error;
  }
}

describe('createMandateTerms - accepts valid terms', () => {
  it('builds terms from complete input', () => {
    const terms = createMandateTerms(validInput);

    expect(terms.perTxnLimitPaise).toBe(200_000);
    expect(terms.windowKind).toBe('week');
    expect(terms.blockedMccs).toEqual(['5921', '7995']);
    expect(terms.timezone).toBe('Asia/Kolkata');
  });

  it('applies sensible defaults for omitted optional fields', () => {
    const terms = createMandateTerms({
      perTxnLimitPaise: 100_000,
      windowLimitPaise: 100_000,
      windowKind: 'day',
      maxTxnPerHour: 1,
      validFrom: new Date('2026-09-01T00:00:00Z'),
      validTo: new Date('2026-09-30T00:00:00Z'),
    });

    expect(terms.blockedMccs).toEqual([]); // nothing blocked
    expect(terms.timezone).toBe('Asia/Kolkata');
    expect(terms.windowStartHour).toBe(0);
    expect(terms.windowEndHour).toBe(24); // any time
    expect(terms.allowedWeekdays).toHaveLength(7); // any day
    expect(terms.paymentMethods).toEqual(['upi_reserve_pay']);
    expect(terms.afaExemptionThresholdPaise).toBe(DEFAULT_AFA_EXEMPTION_THRESHOLD_PAISE);
  });

  it('allows per-transaction limit EQUAL to the window limit', () => {
    // Boundary: equal is coherent (exactly one transaction may use the whole
    // window). Only strictly greater is incoherent.
    expect(() =>
      createMandateTerms({ ...validInput, perTxnLimitPaise: 500_000, windowLimitPaise: 500_000 }),
    ).not.toThrow();
  });

  it('returns a frozen object with defensive date copies', () => {
    // A value object that can be mutated after construction is not one.
    const validFrom = new Date('2026-09-01T00:00:00Z');
    const terms = createMandateTerms({ ...validInput, validFrom });

    expect(Object.isFrozen(terms)).toBe(true);

    // Mutating the caller's Date must not reach inside the value object.
    validFrom.setFullYear(1999);
    expect(terms.validFrom.getUTCFullYear()).toBe(2026);
  });
});

describe('createMandateTerms - amount invariants', () => {
  it('rejects a per-transaction limit above the window limit', () => {
    expect(issueFields({ ...validInput, perTxnLimitPaise: 900_000 })).toContain(
      'perTxnLimitPaise',
    );
  });

  it('rejects zero and negative limits', () => {
    expect(issueFields({ ...validInput, perTxnLimitPaise: 0 })).toContain('perTxnLimitPaise');
    expect(issueFields({ ...validInput, perTxnLimitPaise: -1 })).toContain('perTxnLimitPaise');
  });

  it('rejects a fractional paise amount', () => {
    // There is no unit smaller than a paisa; accepting 200000.5 would mean
    // silently rounding someone's money.
    expect(issueFields({ ...validInput, perTxnLimitPaise: 200_000.5 })).toContain(
      'perTxnLimitPaise',
    );
  });

  it('rejects an amount beyond exact representation', () => {
    expect(issueFields({ ...validInput, windowLimitPaise: Number.MAX_SAFE_INTEGER + 2 })).toContain(
      'windowLimitPaise',
    );
  });
});

describe('createMandateTerms - MCC invariants', () => {
  it('rejects a non-MCC value', () => {
    // MCC blocking is only meaningful if every entry really is an MCC.
    // 'alcohol' would match no merchant and silently block nothing.
    expect(issueFields({ ...validInput, blockedMccs: ['5921', 'alcohol'] })).toContain(
      'blockedMccs',
    );
  });

  it('rejects a three-digit code', () => {
    expect(issueFields({ ...validInput, blockedMccs: ['592'] })).toContain('blockedMccs');
  });

  it('rejects duplicates - which no CHECK constraint can detect', () => {
    // This is one of the invariants that justifies having a domain layer at
    // all: SQL cannot look for repeats inside an array.
    expect(issueFields({ ...validInput, blockedMccs: ['5921', '5921'] })).toContain('blockedMccs');
  });
});

describe('createMandateTerms - timezone', () => {
  it('rejects a timezone the runtime does not know', () => {
    // The other invariant SQL cannot express. A typo would be stored happily
    // and then break every time-window evaluation, silently.
    expect(issueFields({ ...validInput, timezone: 'Asia/Kolkatta' })).toContain('timezone');
  });

  it('accepts other real IANA zones', () => {
    for (const timezone of ['UTC', 'America/New_York', 'Asia/Singapore']) {
      expect(() => createMandateTerms({ ...validInput, timezone })).not.toThrow();
    }
  });
});

describe('createMandateTerms - time window and weekdays', () => {
  it('rejects a window that ends before it starts', () => {
    expect(issueFields({ ...validInput, windowStartHour: 20, windowEndHour: 8 })).toContain(
      'windowEndHour',
    );
  });

  it('rejects a zero-length window', () => {
    expect(issueFields({ ...validInput, windowStartHour: 9, windowEndHour: 9 })).toContain(
      'windowEndHour',
    );
  });

  it('rejects hours outside range', () => {
    expect(issueFields({ ...validInput, windowStartHour: 24 })).toContain('windowStartHour');
    expect(issueFields({ ...validInput, windowEndHour: 25 })).toContain('windowEndHour');
  });

  it('accepts the full-day boundary 0 to 24', () => {
    expect(() =>
      createMandateTerms({ ...validInput, windowStartHour: 0, windowEndHour: 24 }),
    ).not.toThrow();
  });

  it('rejects an empty weekday list', () => {
    // Not "any day" - a mandate that can never fire. This is the same bug the
    // database had when the CHECK used array_length (NULL) instead of
    // cardinality (0), and it is worth catching in both layers.
    expect(issueFields({ ...validInput, allowedWeekdays: [] })).toContain('allowedWeekdays');
  });

  it('rejects a misspelled weekday', () => {
    expect(issueFields({ ...validInput, allowedWeekdays: ['MON', 'FUNDAY'] })).toContain(
      'allowedWeekdays',
    );
  });

  it('rejects duplicate weekdays', () => {
    expect(issueFields({ ...validInput, allowedWeekdays: ['MON', 'MON'] })).toContain(
      'allowedWeekdays',
    );
  });
});

describe('createMandateTerms - validity and payment methods', () => {
  it('rejects validity that ends before it starts', () => {
    expect(
      issueFields({
        ...validInput,
        validFrom: new Date('2026-12-01T00:00:00Z'),
        validTo: new Date('2026-09-01T00:00:00Z'),
      }),
    ).toContain('validTo');
  });

  it('rejects an invalid Date', () => {
    expect(issueFields({ ...validInput, validTo: new Date('not a date') })).toContain('validTo');
  });

  it('rejects an unknown payment method', () => {
    expect(issueFields({ ...validInput, paymentMethods: ['crypto'] })).toContain('paymentMethods');
  });

  it('rejects an empty payment method list', () => {
    expect(issueFields({ ...validInput, paymentMethods: [] })).toContain('paymentMethods');
  });
});

describe('createMandateTerms - reports every problem at once', () => {
  it('lists all invalid fields in one error', () => {
    // One round trip should tell a caller everything they need to fix, rather
    // than one problem per request. Same reasoning as loadConfig.
    const fields = issueFields({
      ...validInput,
      perTxnLimitPaise: 0,
      windowKind: 'fortnight',
      maxTxnPerHour: 0,
      timezone: 'Nowhere/Fake',
      blockedMccs: ['nope'],
      allowedWeekdays: [],
    });

    expect(fields).toContain('perTxnLimitPaise');
    expect(fields).toContain('windowKind');
    expect(fields).toContain('maxTxnPerHour');
    expect(fields).toContain('timezone');
    expect(fields).toContain('blockedMccs');
    expect(fields).toContain('allowedWeekdays');
  });

  it('names the field in every issue, so an API can return a useful 400', () => {
    try {
      createMandateTerms({ ...validInput, perTxnLimitPaise: 0 });
      expect.unreachable('should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(MandateValidationError);
      const issues = (error as MandateValidationError).issues;
      expect(issues.length).toBeGreaterThan(0);
      for (const issue of issues) {
        expect(issue.field).toBeTruthy();
        expect(issue.message).toBeTruthy();
      }
    }
  });
});

describe('derived predicates - time is passed in, never read from the clock', () => {
  const terms = createMandateTerms(validInput);

  it('isExpiredAt is a strict comparison at the boundary', () => {
    // Exactly at validTo is NOT expired; one millisecond later is.
    expect(isExpiredAt(terms, terms.validTo)).toBe(false);
    expect(isExpiredAt(terms, new Date(terms.validTo.getTime() + 1))).toBe(true);
    expect(isExpiredAt(terms, new Date(terms.validTo.getTime() - 1))).toBe(false);
  });

  it('isNotYetValidAt is a strict comparison at the boundary', () => {
    expect(isNotYetValidAt(terms, terms.validFrom)).toBe(false);
    expect(isNotYetValidAt(terms, new Date(terms.validFrom.getTime() - 1))).toBe(true);
  });

  it('expired and not-yet-valid are distinguishable states', () => {
    // Collapsing both into "invalid" would make the explanation wrong in one
    // of the two cases, and the reason text is the product.
    const before = new Date('2026-01-01T00:00:00Z');
    const after = new Date('2027-01-01T00:00:00Z');

    expect(isNotYetValidAt(terms, before)).toBe(true);
    expect(isExpiredAt(terms, before)).toBe(false);

    expect(isExpiredAt(terms, after)).toBe(true);
    expect(isNotYetValidAt(terms, after)).toBe(false);
  });
});

describe('isUsableAt', () => {
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

  const withVersion = (mandate: Mandate): MandateWithVersion => ({
    mandate,
    version: {
      mandateId: mandate.id,
      version: 1,
      terms: createMandateTerms(validInput),
      merchantAllowlist: ['mer_test_shop'],
      createdAt: new Date('2026-09-01T00:00:00Z'),
      createdBy: 'test',
      changeReason: null,
      consentRef: 'consent_test_0001',
      consentAt: new Date('2026-09-01T00:00:00Z'),
    },
  });

  const inWindow = new Date('2026-10-01T12:00:00Z');

  it('is usable when active and inside its validity dates', () => {
    expect(isUsableAt(withVersion(activeMandate), inWindow)).toBe(true);
  });

  it('is not usable when revoked', () => {
    const revoked: Mandate = {
      ...activeMandate,
      status: 'revoked',
      revokedAt: new Date('2026-09-15T00:00:00Z'),
      revokedBy: 'usr_test',
      revokedReason: 'withdrew consent',
    };

    expect(isUsableAt(withVersion(revoked), inWindow)).toBe(false);
  });

  it('is not usable after expiry or before validity', () => {
    expect(isUsableAt(withVersion(activeMandate), new Date('2027-06-01T00:00:00Z'))).toBe(false);
    expect(isUsableAt(withVersion(activeMandate), new Date('2026-01-01T00:00:00Z'))).toBe(false);
  });

  it('ignores the time-of-day window, the allowlist and every limit', () => {
    // Those are individual policy rules in Phase 4, each of which must emit its
    // own Signal -> Rule -> Verdict record. Collapsing them into one boolean
    // here would destroy the explainability the product is built on.
    //
    // 03:00 UTC is 08:30 IST - inside the 08:00-20:00 window - but the point
    // stands regardless: isUsableAt does not consult it.
    const outsideTimeWindow = new Date('2026-10-01T22:00:00Z'); // 03:30 IST
    expect(isUsableAt(withVersion(activeMandate), outsideTimeWindow)).toBe(true);
  });
});
