/**
 * Wire schemas and mappers for mandates.
 *
 * THE WIRE SHAPE IS NOT THE DOMAIN SHAPE.
 *
 *   wire    { "perTxnLimitPaise": 200000, "validFrom": "2026-09-01T00:00:00Z" }
 *   domain  { perTxnLimitPaise: 200000 as Paise, validFrom: Date }
 *
 * Keeping them separate means an API change does not ripple into business
 * logic, and untrusted input cannot reach the domain without passing
 * validation. This module is the only place that knows both shapes.
 *
 * ---------------------------------------------------------------------------
 * DIVISION OF LABOUR - deliberate, to avoid two layers drifting apart:
 *
 *   Zod    owns SHAPE and FORMAT. Is it an integer? A valid ISO-8601 instant?
 *          Does the id match `^mnd_`? Purely per-field questions.
 *
 *   Domain owns MEANING. Is perTxnLimit <= windowLimit? Is the timezone real?
 *          Are there duplicates in the array? Cross-field and semantic.
 *
 * Each rule lives in exactly one place. Zod deliberately does NOT re-check the
 * things createMandateTerms checks.
 * ---------------------------------------------------------------------------
 *
 * MONEY ON THE WIRE IS INTEGER PAISE, matching Razorpay's own API (`amount` in
 * paise). A JSON number is a double, so "2000.10" would already be inexact -
 * integers sidestep the problem entirely rather than mitigating it.
 */
import { z } from 'zod';
import { MAX_SAFE_PAISE } from '../money.js';
import {
  MandateValidationError,
  PAYMENT_METHODS,
  WEEKDAYS,
  WINDOW_KINDS,
  createMandateTerms,
  type Mandate,
  type MandateVersion,
  type ValidationIssue,
} from '../domain/mandate.js';

/* ------------------------------------------------------------------------ */
/* Reusable field schemas                                                   */
/* ------------------------------------------------------------------------ */

/**
 * Ids are validated at the boundary even though the database also rejects a
 * wrong prefix. Catching it here turns a confusing 500 (constraint violation
 * surfacing from a repository) into a clear 400 naming the field.
 */
const idSchema = (prefix: string) =>
  z
    .string()
    .regex(
      new RegExp(`^${prefix}_[a-z0-9_]{2,40}$`),
      `must be an id of the form ${prefix}_… (lowercase letters, digits, underscores)`,
    );

/**
 * z.int() rather than z.number().int(): it also rejects values beyond safe
 * integer range, so 2^53+1 cannot arrive and be silently rounded.
 */
const paiseSchema = z
  .int('must be a whole number of paise')
  .positive('must be greater than zero')
  .max(MAX_SAFE_PAISE, `must not exceed ${MAX_SAFE_PAISE} paise`);

/**
 * z.iso.datetime() requires a full instant, so a bare "2026-09-01" is refused.
 * A date without a time is ambiguous about which moment it means, and in a
 * validity window that ambiguity is a day of unintended authority.
 */
const instantSchema = z.iso.datetime('must be an ISO-8601 instant, e.g. 2026-09-01T00:00:00Z');

const mccSchema = z
  .string()
  .regex(/^[0-9]{4}$/, 'must be a four-digit ISO 18245 merchant category code');

/** Standard IFSC: 4 bank letters, a 0, then 6 branch characters. */
const ifscSchema = z
  .string()
  .regex(/^[A-Z]{4}0[A-Z0-9]{6}$/, 'must be a valid IFSC, e.g. HDFC0000001');

/* ------------------------------------------------------------------------ */
/* Terms                                                                    */
/* ------------------------------------------------------------------------ */

/**
 * strictObject, NOT object.
 *
 * Plain z.object() ACCEPTS unknown keys and silently STRIPS them. So
 * {"perTxnLimitPais": 500} - one missing character - would parse successfully,
 * the field would be dropped, and the caller would believe they had set a
 * spending limit that was never applied. In a limits API that is a security
 * bug wearing a typo's clothing.
 *
 * Optional fields are left optional here and defaulted by the DOMAIN, so the
 * default values have exactly one home.
 */
export const termsSchema = z.strictObject({
  perTxnLimitPaise: paiseSchema,
  windowLimitPaise: paiseSchema,
  windowKind: z.enum(WINDOW_KINDS),
  maxTxnPerHour: z.int().min(1, 'must be at least 1'),

  blockedMccs: z.array(mccSchema).max(64, 'at most 64 blocked categories').optional(),

  timezone: z.string().min(1).max(64).optional(),
  windowStartHour: z.int().min(0).max(23).optional(),
  windowEndHour: z.int().min(1).max(24).optional(),
  allowedWeekdays: z.array(z.enum(WEEKDAYS)).max(7).optional(),

  validFrom: instantSchema,
  validTo: instantSchema,

  paymentMethods: z.array(z.enum(PAYMENT_METHODS)).max(4).optional(),
  afaExemptionThresholdPaise: paiseSchema.optional(),
});

export type TermsDto = z.infer<typeof termsSchema>;

/* ------------------------------------------------------------------------ */
/* Request bodies                                                           */
/* ------------------------------------------------------------------------ */

/**
 * Consent is required on every mandate version, including the first
 * (migration 0006). Required here so a caller gets a 400 naming the field,
 * rather than a NOT NULL violation surfacing as a 500.
 */
const consentFields = {
  consentRef: z
    .string()
    .trim()
    .min(1, 'is required: every version needs recorded consent')
    .max(200),
  consentAt: instantSchema,
} as const;

export const createMandateBodySchema = z.strictObject({
  userId: idSchema('usr'),
  agentId: idSchema('agt'),
  label: z.string().trim().min(1, 'is required').max(120),

  terms: termsSchema,

  /**
   * An EMPTY array is permitted and means NO merchant is allowed - deny by
   * default. It must stay distinguishable from "not provided", which is why
   * this is required rather than optional with a default.
   */
  merchantIds: z.array(idSchema('mer')).max(50, 'at most 50 merchants'),

  ...consentFields,
  createdBy: z.string().trim().min(1).max(120),
  changeReason: z.string().trim().max(500).optional(),

  /** Optional: triggers a cold-path bank lookup. Never on the hot path. */
  ifsc: ifscSchema.optional(),
});

export type CreateMandateBody = z.infer<typeof createMandateBodySchema>;

export const addVersionBodySchema = z.strictObject({
  terms: termsSchema,
  merchantIds: z.array(idSchema('mer')).max(50),
  ...consentFields,
  createdBy: z.string().trim().min(1).max(120),
  changeReason: z.string().trim().max(500).optional(),
});

export type AddVersionBody = z.infer<typeof addVersionBodySchema>;

export const revokeMandateBodySchema = z.strictObject({
  revokedBy: z.string().trim().min(1).max(120),
  /**
   * Required, not optional. A revocation without a reason is exactly what a
   * dispute or an audit will ask about, and "we revoked it but did not note
   * why" is not an answer. The database enforces this too.
   */
  revokedReason: z.string().trim().min(1, 'is required').max(500),
});

export type RevokeMandateBody = z.infer<typeof revokeMandateBodySchema>;

/* ------------------------------------------------------------------------ */
/* Wire -> domain                                                           */
/* ------------------------------------------------------------------------ */

/**
 * Convert validated wire terms into domain terms.
 *
 * Deliberately thin: it converts ISO strings to Dates and hands everything to
 * createMandateTerms, which owns every semantic rule. If this function grew
 * validation of its own, that rule would then exist in two places.
 */
export function termsToDomain(dto: TermsDto) {
  return createMandateTerms({
    perTxnLimitPaise: dto.perTxnLimitPaise,
    windowLimitPaise: dto.windowLimitPaise,
    windowKind: dto.windowKind,
    maxTxnPerHour: dto.maxTxnPerHour,
    ...(dto.blockedMccs !== undefined ? { blockedMccs: dto.blockedMccs } : {}),
    ...(dto.timezone !== undefined ? { timezone: dto.timezone } : {}),
    ...(dto.windowStartHour !== undefined ? { windowStartHour: dto.windowStartHour } : {}),
    ...(dto.windowEndHour !== undefined ? { windowEndHour: dto.windowEndHour } : {}),
    ...(dto.allowedWeekdays !== undefined ? { allowedWeekdays: dto.allowedWeekdays } : {}),
    validFrom: new Date(dto.validFrom),
    validTo: new Date(dto.validTo),
    ...(dto.paymentMethods !== undefined ? { paymentMethods: dto.paymentMethods } : {}),
    ...(dto.afaExemptionThresholdPaise !== undefined
      ? { afaExemptionThresholdPaise: dto.afaExemptionThresholdPaise }
      : {}),
  });
}

/* ------------------------------------------------------------------------ */
/* Domain -> wire                                                           */
/* ------------------------------------------------------------------------ */

export interface MandateVersionResponse {
  readonly version: number;
  readonly terms: {
    readonly perTxnLimitPaise: number;
    readonly windowLimitPaise: number;
    readonly windowKind: string;
    readonly maxTxnPerHour: number;
    readonly blockedMccs: readonly string[];
    readonly timezone: string;
    readonly windowStartHour: number;
    readonly windowEndHour: number;
    readonly allowedWeekdays: readonly string[];
    readonly validFrom: string;
    readonly validTo: string;
    readonly paymentMethods: readonly string[];
    readonly afaExemptionThresholdPaise: number;
  };
  readonly merchantIds: readonly string[];
  readonly createdAt: string;
  readonly createdBy: string;
  readonly changeReason: string | null;
  readonly consentRef: string;
  readonly consentAt: string;
}

export interface MandateResponse {
  readonly id: string;
  readonly userId: string;
  readonly agentId: string;
  readonly label: string;
  readonly status: string;
  readonly revokedAt: string | null;
  readonly revokedBy: string | null;
  readonly revokedReason: string | null;
  readonly createdAt: string;
  readonly currentVersion: MandateVersionResponse;
}

/**
 * Money leaves as integer paise, with no formatted string alongside it.
 *
 * Formatting is a presentation concern that depends on the viewer's locale, and
 * shipping both invites them to disagree. The dashboard formats with Intl in
 * en-IN; the API states the exact amount.
 */
export function versionToWire(version: MandateVersion): MandateVersionResponse {
  const { terms } = version;

  return {
    version: version.version,
    terms: {
      perTxnLimitPaise: terms.perTxnLimitPaise,
      windowLimitPaise: terms.windowLimitPaise,
      windowKind: terms.windowKind,
      maxTxnPerHour: terms.maxTxnPerHour,
      blockedMccs: terms.blockedMccs,
      timezone: terms.timezone,
      windowStartHour: terms.windowStartHour,
      windowEndHour: terms.windowEndHour,
      allowedWeekdays: terms.allowedWeekdays,
      validFrom: terms.validFrom.toISOString(),
      validTo: terms.validTo.toISOString(),
      paymentMethods: terms.paymentMethods,
      afaExemptionThresholdPaise: terms.afaExemptionThresholdPaise,
    },
    merchantIds: version.merchantAllowlist,
    createdAt: version.createdAt.toISOString(),
    createdBy: version.createdBy,
    changeReason: version.changeReason,
    consentRef: version.consentRef,
    consentAt: version.consentAt.toISOString(),
  };
}

export function mandateToWire(mandate: Mandate, version: MandateVersion): MandateResponse {
  return {
    id: mandate.id,
    userId: mandate.userId,
    agentId: mandate.agentId,
    label: mandate.label,
    status: mandate.status,
    revokedAt: mandate.revokedAt?.toISOString() ?? null,
    revokedBy: mandate.revokedBy,
    revokedReason: mandate.revokedReason,
    createdAt: mandate.createdAt.toISOString(),
    currentVersion: versionToWire(version),
  };
}

/* ------------------------------------------------------------------------ */
/* Errors -> a single 400 shape                                             */
/* ------------------------------------------------------------------------ */

export interface ValidationErrorBody {
  readonly error: 'validation_failed';
  readonly message: string;
  readonly issues: readonly ValidationIssue[];
}

/**
 * Normalise a Zod error and a MandateValidationError into ONE response shape.
 *
 * A caller should not have to care whether their input failed a shape check or
 * a semantic one - both are "you sent something invalid, here is every field
 * that is wrong". Reporting all issues at once means one round trip fixes
 * everything, the same principle as loadConfig.
 */
export function toValidationErrorBody(error: unknown): ValidationErrorBody | null {
  if (error instanceof z.ZodError) {
    return {
      error: 'validation_failed',
      message: 'Request body is invalid.',
      issues: error.issues.map((issue) => ({
        field: issue.path.length > 0 ? issue.path.join('.') : '(body)',
        message: issue.message,
      })),
    };
  }

  if (error instanceof MandateValidationError) {
    return {
      error: 'validation_failed',
      message: 'Mandate terms are invalid.',
      issues: error.issues,
    };
  }

  return null;
}
