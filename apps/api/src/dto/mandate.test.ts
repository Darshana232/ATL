import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  addVersionBodySchema,
  createMandateBodySchema,
  mandateToWire,
  revokeMandateBodySchema,
  termsSchema,
  termsToDomain,
  toValidationErrorBody,
  versionToWire,
} from './mandate.js';
import { MandateValidationError, createMandateTerms } from '../domain/mandate.js';
import type { Mandate, MandateVersion } from '../domain/mandate.js';

const validTerms = {
  perTxnLimitPaise: 200_000,
  windowLimitPaise: 500_000,
  windowKind: 'week',
  maxTxnPerHour: 5,
  validFrom: '2026-09-01T00:00:00Z',
  validTo: '2026-12-31T23:59:59Z',
} as const;

const validCreateBody = {
  userId: 'usr_ananya',
  agentId: 'agt_grocery_shopper',
  label: 'Weekly groceries',
  terms: validTerms,
  merchantIds: ['mer_bigbasket'],
  consentRef: 'consent_abc_001',
  consentAt: '2026-09-01T08:55:00Z',
  createdBy: 'admin',
} as const;

/** Field names a rejected body complains about. */
function fieldsFor(schema: z.ZodType, body: unknown): string[] {
  const result = schema.safeParse(body);
  if (result.success) return [];
  return result.error.issues.map((issue) => issue.path.join('.'));
}

describe('strictObject: unknown fields are an ERROR, never silently dropped', () => {
  it('rejects a typo in a limit field', () => {
    // THE case this matters for. With plain z.object() the misspelled key is
    // stripped, the body parses, and the caller believes they set a spending
    // limit that was never applied. A security bug wearing a typo's clothing.
    const typo = { ...validTerms, perTxnLimitPais: 999 };
    const result = termsSchema.safeParse(typo);

    expect(result.success).toBe(false);
  });

  it('documents what plain z.object would have done instead', () => {
    // Asserted so the hazard is visible rather than described.
    const loose = z.object({ perTxnLimitPaise: z.int() });
    const parsed = loose.safeParse({ perTxnLimitPaise: 1, perTxnLimitPais: 999 });

    expect(parsed.success).toBe(true);
    expect(parsed.data).toEqual({ perTxnLimitPaise: 1 }); // the typo VANISHED
  });

  it('rejects unknown fields at the top level too', () => {
    expect(
      createMandateBodySchema.safeParse({ ...validCreateBody, isAdmin: true }).success,
    ).toBe(false);
  });
});

describe('money on the wire is integer paise', () => {
  it('rejects a decimal amount', () => {
    // A JSON number is a double, so 2000.10 is already inexact. Integers
    // sidestep the problem rather than mitigating it.
    expect(fieldsFor(termsSchema, { ...validTerms, perTxnLimitPaise: 2000.5 })).toContain(
      'perTxnLimitPaise',
    );
  });

  it('rejects zero and negative amounts', () => {
    expect(fieldsFor(termsSchema, { ...validTerms, perTxnLimitPaise: 0 })).toContain(
      'perTxnLimitPaise',
    );
    expect(fieldsFor(termsSchema, { ...validTerms, perTxnLimitPaise: -1 })).toContain(
      'perTxnLimitPaise',
    );
  });

  it('rejects an amount beyond exact representation', () => {
    expect(
      fieldsFor(termsSchema, { ...validTerms, windowLimitPaise: 9007199254740993 }),
    ).toContain('windowLimitPaise');
  });

  it('rejects a numeric string', () => {
    expect(fieldsFor(termsSchema, { ...validTerms, perTxnLimitPaise: '200000' })).toContain(
      'perTxnLimitPaise',
    );
  });
});

describe('dates must be unambiguous instants', () => {
  it('rejects a bare date with no time', () => {
    // "2026-09-01" does not say which moment it means, and in a validity
    // window that ambiguity is a day of unintended authority.
    expect(fieldsFor(termsSchema, { ...validTerms, validFrom: '2026-09-01' })).toContain(
      'validFrom',
    );
  });

  it('accepts a full ISO-8601 instant', () => {
    expect(termsSchema.safeParse(validTerms).success).toBe(true);
  });

  it('rejects nonsense date strings', () => {
    expect(fieldsFor(termsSchema, { ...validTerms, validTo: 'next tuesday' })).toContain(
      'validTo',
    );
  });
});

describe('id prefixes are checked at the boundary', () => {
  it('rejects an id with the wrong prefix', () => {
    // Catching it here turns a confusing 500 (a constraint violation surfacing
    // from the repository) into a 400 that names the field.
    expect(fieldsFor(createMandateBodySchema, { ...validCreateBody, userId: 'agt_wrong' }))
      .toContain('userId');
  });

  it('rejects an id with no prefix at all', () => {
    expect(fieldsFor(createMandateBodySchema, { ...validCreateBody, userId: 'ananya' }))
      .toContain('userId');
  });

  it('rejects a malformed merchant id inside the array', () => {
    expect(
      fieldsFor(createMandateBodySchema, { ...validCreateBody, merchantIds: ['bigbasket'] }),
    ).toContain('merchantIds.0');
  });
});

describe('consent is required on every version', () => {
  it('rejects a create with no consent reference', () => {
    const { consentRef: _omitted, ...withoutConsent } = validCreateBody;
    expect(fieldsFor(createMandateBodySchema, withoutConsent)).toContain('consentRef');
  });

  it('rejects a blank consent reference', () => {
    expect(fieldsFor(createMandateBodySchema, { ...validCreateBody, consentRef: '   ' }))
      .toContain('consentRef');
  });

  it('rejects a new version with no consent', () => {
    expect(
      fieldsFor(addVersionBodySchema, {
        terms: validTerms,
        merchantIds: ['mer_bigbasket'],
        createdBy: 'admin',
      }),
    ).toContain('consentRef');
  });
});

describe('an empty allowlist is meaningful, not missing', () => {
  it('accepts an empty merchantIds array', () => {
    // Empty means NO merchant is permitted - deny by default. It must stay
    // distinguishable from "not provided", which is why the field is required.
    expect(
      createMandateBodySchema.safeParse({ ...validCreateBody, merchantIds: [] }).success,
    ).toBe(true);
  });

  it('rejects merchantIds being omitted entirely', () => {
    const { merchantIds: _omitted, ...withoutMerchants } = validCreateBody;
    expect(fieldsFor(createMandateBodySchema, withoutMerchants)).toContain('merchantIds');
  });
});

describe('revocation requires a reason', () => {
  it('rejects a revocation with no reason', () => {
    expect(fieldsFor(revokeMandateBodySchema, { revokedBy: 'usr_ananya' }))
      .toContain('revokedReason');
  });

  it('accepts a complete revocation', () => {
    expect(
      revokeMandateBodySchema.safeParse({
        revokedBy: 'usr_ananya',
        revokedReason: 'user withdrew consent',
      }).success,
    ).toBe(true);
  });
});

describe('termsToDomain delegates SEMANTICS to the domain', () => {
  it('converts ISO strings into Dates', () => {
    const terms = termsToDomain(termsSchema.parse(validTerms));

    expect(terms.validFrom).toBeInstanceOf(Date);
    expect(terms.validFrom.toISOString()).toBe('2026-09-01T00:00:00.000Z');
  });

  it('lets the DOMAIN apply defaults, so they have one home', () => {
    const terms = termsToDomain(termsSchema.parse(validTerms));

    expect(terms.timezone).toBe('Asia/Kolkata');
    expect(terms.windowStartHour).toBe(0);
    expect(terms.windowEndHour).toBe(24);
    expect(terms.allowedWeekdays).toHaveLength(7);
    expect(terms.blockedMccs).toEqual([]);
  });

  it('surfaces a cross-field failure the schema deliberately does not check', () => {
    // Zod validates each field independently; only the domain knows that a
    // per-transaction limit above the window limit is incoherent.
    const parsed = termsSchema.parse({
      ...validTerms,
      perTxnLimitPaise: 900_000,
      windowLimitPaise: 500_000,
    });

    expect(() => termsToDomain(parsed)).toThrow(MandateValidationError);
  });

  it('surfaces an invalid timezone, which SQL cannot detect either', () => {
    const parsed = termsSchema.parse({ ...validTerms, timezone: 'Asia/Kolkatta' });

    expect(() => termsToDomain(parsed)).toThrow(/timezone/);
  });
});

describe('toValidationErrorBody normalises both failure kinds', () => {
  it('maps a Zod error, naming every bad field', () => {
    const result = createMandateBodySchema.safeParse({ ...validCreateBody, userId: 'nope' });
    const body = toValidationErrorBody(result.success ? null : result.error);

    expect(body?.error).toBe('validation_failed');
    expect(body?.issues.map((issue) => issue.field)).toContain('userId');
  });

  it('maps a domain error into the SAME shape', () => {
    // A caller should not have to care whether their input failed a shape
    // check or a semantic one.
    let body = null;
    try {
      createMandateTerms({ ...validTerms, perTxnLimitPaise: 0, validFrom: new Date(), validTo: new Date() });
    } catch (error) {
      body = toValidationErrorBody(error);
    }

    expect(body?.error).toBe('validation_failed');
    expect(body?.issues.length).toBeGreaterThan(0);
    for (const issue of body?.issues ?? []) {
      expect(issue.field).toBeTruthy();
      expect(issue.message).toBeTruthy();
    }
  });

  it('returns null for an unrelated error, so it is not swallowed as a 400', () => {
    // A genuine bug must surface as a 500, not be mislabelled a client error.
    expect(toValidationErrorBody(new TypeError('a real bug'))).toBeNull();
  });

  it('reports EVERY problem at once', () => {
    const result = createMandateBodySchema.safeParse({
      ...validCreateBody,
      userId: 'bad',
      agentId: 'also_bad',
      label: '',
    });
    const body = toValidationErrorBody(result.success ? null : result.error);
    const fields = body?.issues.map((issue) => issue.field) ?? [];

    expect(fields).toContain('userId');
    expect(fields).toContain('agentId');
    expect(fields).toContain('label');
  });
});

describe('domain -> wire', () => {
  const mandate: Mandate = {
    id: 'mnd_weekly_groceries',
    userId: 'usr_ananya',
    agentId: 'agt_grocery_shopper',
    label: 'Weekly groceries',
    status: 'active',
    revokedAt: null,
    revokedBy: null,
    revokedReason: null,
    createdAt: new Date('2026-09-01T00:00:00Z'),
  };

  const version: MandateVersion = {
    mandateId: 'mnd_weekly_groceries',
    version: 3,
    terms: createMandateTerms({
      perTxnLimitPaise: 200_000,
      windowLimitPaise: 500_000,
      windowKind: 'week',
      maxTxnPerHour: 5,
      blockedMccs: ['5921', '7995'],
      validFrom: new Date('2026-09-01T00:00:00Z'),
      validTo: new Date('2026-12-31T23:59:59Z'),
    }),
    merchantAllowlist: ['mer_bigbasket', 'mer_zepto'],
    createdAt: new Date('2026-09-03T07:45:00Z'),
    createdBy: 'admin',
    changeReason: 'user blocked alcohol and gambling',
    consentRef: 'consent_abc_003',
    consentAt: new Date('2026-09-03T07:40:00Z'),
  };

  it('emits integer paise and ISO strings', () => {
    const wire = versionToWire(version);

    expect(wire.terms.perTxnLimitPaise).toBe(200_000);
    expect(typeof wire.terms.perTxnLimitPaise).toBe('number');
    expect(wire.terms.validFrom).toBe('2026-09-01T00:00:00.000Z');
    expect(wire.consentAt).toBe('2026-09-03T07:40:00.000Z');
  });

  it('does NOT emit a formatted money string alongside the number', () => {
    // Shipping both invites them to disagree. Formatting is locale-dependent
    // presentation; the API states the exact amount.
    const serialised = JSON.stringify(versionToWire(version));

    expect(serialised).not.toContain('₹');
    expect(serialised).not.toMatch(/2,000/);
  });

  it('round-trips through the wire schema it claims to produce', () => {
    // Guards against the response shape drifting away from the request shape.
    const wire = versionToWire(version);
    const reparsed = termsSchema.safeParse(wire.terms);

    expect(reparsed.success).toBe(true);
  });

  it('includes the consent trail on the mandate response', () => {
    const wire = mandateToWire(mandate, version);

    expect(wire.id).toBe('mnd_weekly_groceries');
    expect(wire.currentVersion.version).toBe(3);
    expect(wire.currentVersion.consentRef).toBe('consent_abc_003');
    expect(wire.revokedAt).toBeNull();
  });
});
