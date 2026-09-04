/**
 * The mandate domain model.
 *
 * PURE: no database, no clock, no network, no logging. Time is passed in when
 * needed. That is what lets Phase 4's policy engine consume these types
 * without any infrastructure, and what makes every function here trivially
 * testable.
 *
 * ---------------------------------------------------------------------------
 * WHY VALIDATE HERE WHEN THE DATABASE ALREADY DOES?
 *
 * Migration 0003 enforces almost all of these invariants with CHECK
 * constraints, and those are the real backstop - they hold even against psql.
 * This layer is not a replacement for them. It exists for three reasons:
 *
 *   1. USEFUL ERRORS. The database says "violates check constraint
 *      mandate_versions_per_txn_within_window". The API needs to tell a caller
 *      WHICH FIELD is wrong and why, as a 400 - and to report every problem at
 *      once rather than one per round trip.
 *
 *   2. NO DATABASE REQUIRED. The Phase 4 engine evaluates terms as values.
 *      Requiring a live Postgres to know whether terms are coherent would make
 *      the engine untestable in isolation.
 *
 *   3. INVARIANTS SQL CANNOT EXPRESS. A CHECK constraint cannot tell whether
 *      "Asia/Kolkata" is a real IANA timezone, and cannot detect duplicate
 *      entries inside an array. Both are checked here.
 *
 * The risk of two layers is DRIFT - the domain accepting something the database
 * rejects, so a caller gets a 500 instead of a 400. `mandate.test.ts` guards
 * this by asserting that inputs the database refuses are also refused here.
 * ---------------------------------------------------------------------------
 */
import { MAX_SAFE_PAISE, toPaise, type Paise } from '../money.js';

/* ------------------------------------------------------------------------ */
/* Enumerations - single source of truth, reused by the Zod wire schemas.   */
/* ------------------------------------------------------------------------ */

export const WINDOW_KINDS = ['day', 'week', 'month'] as const;
export type WindowKind = (typeof WINDOW_KINDS)[number];

export const WEEKDAYS = ['MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT', 'SUN'] as const;
export type Weekday = (typeof WEEKDAYS)[number];

export const PAYMENT_METHODS = [
  'upi_reserve_pay',
  'upi_autopay',
  'card',
  'netbanking',
] as const;
export type PaymentMethod = (typeof PAYMENT_METHODS)[number];

export const MANDATE_STATUSES = ['active', 'revoked'] as const;
export type MandateStatus = (typeof MANDATE_STATUSES)[number];

/**
 * NPCI's AFA-exemption ceiling for UPI Autopay (circular UPI/OC-151A,
 * 14 Dec 2023): ₹1,00,000 for specific MCCs, ₹15,000 otherwise.
 *
 * INFORMATIONAL. It governs whether a UPI PIN is required, on a rail we do not
 * operate, so we record and display it - we never enforce it. The research
 * treats this threshold as a mandate spending cap; it is not. They are two
 * different rules with two different owners.
 */
export const DEFAULT_AFA_EXEMPTION_THRESHOLD_PAISE = 10_000_000; // ₹1,00,000

/* ------------------------------------------------------------------------ */
/* Errors                                                                   */
/* ------------------------------------------------------------------------ */

export interface ValidationIssue {
  readonly field: string;
  readonly message: string;
}

/**
 * Carries EVERY problem, not just the first - so one round trip tells a caller
 * all of what to fix. Same reasoning as `loadConfig`.
 */
export class MandateValidationError extends Error {
  override readonly name = 'MandateValidationError';

  constructor(readonly issues: readonly ValidationIssue[]) {
    super(
      `Invalid mandate terms:\n${issues
        .map((issue) => `  - ${issue.field}: ${issue.message}`)
        .join('\n')}`,
    );
  }
}

/* ------------------------------------------------------------------------ */
/* MandateTerms - a value object                                            */
/* ------------------------------------------------------------------------ */

/**
 * What an agent is permitted to do. Immutable and known-coherent once
 * constructed, so every consumer can skip re-checking.
 *
 * Corresponds 1:1 to a row in `mandate_versions`.
 */
export interface MandateTerms {
  readonly perTxnLimitPaise: Paise;
  readonly windowLimitPaise: Paise;
  readonly windowKind: WindowKind;
  readonly maxTxnPerHour: number;
  /** ISO 18245 MCCs the agent must not transact in. Empty = none blocked. */
  readonly blockedMccs: readonly string[];
  /** IANA zone. The time window below is expressed in THIS zone, not UTC. */
  readonly timezone: string;
  readonly windowStartHour: number;
  readonly windowEndHour: number;
  readonly allowedWeekdays: readonly Weekday[];
  readonly validFrom: Date;
  readonly validTo: Date;
  readonly paymentMethods: readonly PaymentMethod[];
  readonly afaExemptionThresholdPaise: Paise;
}

/** Loose input, as it arrives from the wire or a test. */
export interface MandateTermsInput {
  readonly perTxnLimitPaise: number;
  readonly windowLimitPaise: number;
  readonly windowKind: string;
  readonly maxTxnPerHour: number;
  readonly blockedMccs?: readonly string[];
  readonly timezone?: string;
  readonly windowStartHour?: number;
  readonly windowEndHour?: number;
  readonly allowedWeekdays?: readonly string[];
  readonly validFrom: Date;
  readonly validTo: Date;
  readonly paymentMethods?: readonly string[];
  readonly afaExemptionThresholdPaise?: number;
}

const MCC_PATTERN = /^[0-9]{4}$/;

/**
 * Is this a timezone the runtime actually knows?
 *
 * A CHECK constraint cannot answer this, which is precisely why the domain
 * layer earns its place. A typo like 'Asia/Kolkatta' would otherwise be stored
 * happily and then silently break every time-window evaluation.
 */
function isValidTimeZone(timezone: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: timezone });
    return true;
  } catch {
    return false;
  }
}

function findDuplicates(values: readonly string[]): string[] {
  const seen = new Set<string>();
  const duplicates = new Set<string>();

  for (const value of values) {
    if (seen.has(value)) duplicates.add(value);
    seen.add(value);
  }

  return [...duplicates];
}

/**
 * Build coherent `MandateTerms`, or throw with every problem listed.
 *
 * The ONLY way to obtain a `MandateTerms`, so a value of that type is always
 * valid by construction.
 */
export function createMandateTerms(input: MandateTermsInput): MandateTerms {
  const issues: ValidationIssue[] = [];
  const add = (field: string, message: string): void => {
    issues.push({ field, message });
  };

  /* --- Amounts -------------------------------------------------------- */
  const checkPaise = (field: string, value: number): void => {
    if (!Number.isInteger(value)) add(field, 'must be a whole number of paise');
    else if (value <= 0) add(field, 'must be greater than zero');
    else if (value > MAX_SAFE_PAISE) add(field, `must not exceed ${MAX_SAFE_PAISE} paise`);
  };

  checkPaise('perTxnLimitPaise', input.perTxnLimitPaise);
  checkPaise('windowLimitPaise', input.windowLimitPaise);

  // Incoherent rather than merely unusual: with a per-transaction limit above
  // the window limit, the second transaction could never succeed.
  if (
    Number.isInteger(input.perTxnLimitPaise) &&
    Number.isInteger(input.windowLimitPaise) &&
    input.perTxnLimitPaise > input.windowLimitPaise
  ) {
    add(
      'perTxnLimitPaise',
      'must not exceed windowLimitPaise; a single transaction could never fit in the window',
    );
  }

  const afaThreshold = input.afaExemptionThresholdPaise ?? DEFAULT_AFA_EXEMPTION_THRESHOLD_PAISE;
  checkPaise('afaExemptionThresholdPaise', afaThreshold);

  /* --- Window kind ---------------------------------------------------- */
  if (!(WINDOW_KINDS as readonly string[]).includes(input.windowKind)) {
    add('windowKind', `must be one of ${WINDOW_KINDS.join(', ')}`);
  }

  /* --- Velocity ------------------------------------------------------- */
  if (!Number.isInteger(input.maxTxnPerHour) || input.maxTxnPerHour < 1) {
    add('maxTxnPerHour', 'must be a whole number of at least 1');
  }

  /* --- Blocked MCCs --------------------------------------------------- */
  const blockedMccs = input.blockedMccs ?? [];
  for (const mcc of blockedMccs) {
    if (!MCC_PATTERN.test(mcc)) {
      add('blockedMccs', `"${mcc}" is not a four-digit ISO 18245 merchant category code`);
    }
  }
  // A CHECK constraint cannot detect duplicates inside an array.
  const duplicateMccs = findDuplicates(blockedMccs);
  if (duplicateMccs.length > 0) {
    add('blockedMccs', `contains duplicates: ${duplicateMccs.join(', ')}`);
  }

  /* --- Timezone ------------------------------------------------------- */
  const timezone = input.timezone ?? 'Asia/Kolkata';
  if (!isValidTimeZone(timezone)) {
    add('timezone', `"${timezone}" is not a timezone this runtime recognises`);
  }

  /* --- Time window (expressed in `timezone`, not UTC) ----------------- */
  const startHour = input.windowStartHour ?? 0;
  const endHour = input.windowEndHour ?? 24;

  if (!Number.isInteger(startHour) || startHour < 0 || startHour > 23) {
    add('windowStartHour', 'must be a whole number from 0 to 23');
  }
  if (!Number.isInteger(endHour) || endHour < 1 || endHour > 24) {
    add('windowEndHour', 'must be a whole number from 1 to 24');
  }
  if (Number.isInteger(startHour) && Number.isInteger(endHour) && endHour <= startHour) {
    add('windowEndHour', 'must be later than windowStartHour');
  }

  /* --- Weekdays ------------------------------------------------------- */
  const weekdays = input.allowedWeekdays ?? WEEKDAYS;
  if (weekdays.length === 0) {
    // Not "any day" - a mandate that can never fire.
    add('allowedWeekdays', 'must list at least one day');
  }
  for (const day of weekdays) {
    if (!(WEEKDAYS as readonly string[]).includes(day)) {
      add('allowedWeekdays', `"${day}" is not a weekday (expected ${WEEKDAYS.join(', ')})`);
    }
  }
  const duplicateDays = findDuplicates(weekdays);
  if (duplicateDays.length > 0) {
    add('allowedWeekdays', `contains duplicates: ${duplicateDays.join(', ')}`);
  }

  /* --- Validity ------------------------------------------------------- */
  if (Number.isNaN(input.validFrom.getTime())) add('validFrom', 'is not a valid date');
  if (Number.isNaN(input.validTo.getTime())) add('validTo', 'is not a valid date');
  if (
    !Number.isNaN(input.validFrom.getTime()) &&
    !Number.isNaN(input.validTo.getTime()) &&
    input.validTo.getTime() <= input.validFrom.getTime()
  ) {
    add('validTo', 'must be after validFrom');
  }

  /* --- Payment methods ------------------------------------------------ */
  const paymentMethods = input.paymentMethods ?? ['upi_reserve_pay'];
  if (paymentMethods.length === 0) {
    add('paymentMethods', 'must list at least one payment method');
  }
  for (const method of paymentMethods) {
    if (!(PAYMENT_METHODS as readonly string[]).includes(method)) {
      add('paymentMethods', `"${method}" is not a supported payment method`);
    }
  }
  const duplicateMethods = findDuplicates(paymentMethods);
  if (duplicateMethods.length > 0) {
    add('paymentMethods', `contains duplicates: ${duplicateMethods.join(', ')}`);
  }

  if (issues.length > 0) throw new MandateValidationError(issues);

  // Frozen: a value object that can be mutated after construction is not one.
  return Object.freeze({
    perTxnLimitPaise: toPaise(input.perTxnLimitPaise),
    windowLimitPaise: toPaise(input.windowLimitPaise),
    windowKind: input.windowKind as WindowKind,
    maxTxnPerHour: input.maxTxnPerHour,
    blockedMccs: Object.freeze([...blockedMccs]),
    timezone,
    windowStartHour: startHour,
    windowEndHour: endHour,
    allowedWeekdays: Object.freeze([...weekdays] as Weekday[]),
    validFrom: new Date(input.validFrom.getTime()),
    validTo: new Date(input.validTo.getTime()),
    paymentMethods: Object.freeze([...paymentMethods] as PaymentMethod[]),
    afaExemptionThresholdPaise: toPaise(afaThreshold),
  });
}

/* ------------------------------------------------------------------------ */
/* Mandate and MandateVersion                                               */
/* ------------------------------------------------------------------------ */

/** Identity and lifecycle. Carries no terms - those live on versions. */
export interface Mandate {
  readonly id: string;
  readonly userId: string;
  readonly agentId: string;
  readonly label: string;
  readonly status: MandateStatus;
  readonly revokedAt: Date | null;
  readonly revokedBy: string | null;
  readonly revokedReason: string | null;
  readonly createdAt: Date;
}

/** One immutable set of terms, plus who authorised it and when. */
export interface MandateVersion {
  readonly mandateId: string;
  readonly version: number;
  readonly terms: MandateTerms;
  /** Empty means NO merchant is permitted - deny by default, never "all". */
  readonly merchantAllowlist: readonly string[];
  readonly createdAt: Date;
  readonly createdBy: string;
  readonly changeReason: string | null;
  /**
   * Reference to the consent record authorising these terms. Required on every
   * version (migration 0006). In Phase 3 this is caller-supplied: we enforce
   * that a reference is RECORDED, not that a human agreed.
   */
  readonly consentRef: string;
  readonly consentAt: Date;
}

/**
 * The aggregate the policy engine evaluates: a mandate plus the version being
 * applied. Loaded and written as one unit, because a mandate with no version
 * is not a valid state.
 */
export interface MandateWithVersion {
  readonly mandate: Mandate;
  readonly version: MandateVersion;
}

/* ------------------------------------------------------------------------ */
/* Derived predicates - pure, with time passed IN                           */
/* ------------------------------------------------------------------------ */

/**
 * Expiry is COMPUTED, never stored.
 *
 * A stored 'expired' status would need a scheduled job to stay truthful, and
 * until it ran the row would claim to be active while being past validTo - a
 * lie sitting in the database. See migration 0003.
 *
 * `now` is a parameter, not `Date.now()`: that is what makes this deterministic
 * and testable, and it is the same discipline the Phase 4 engine follows.
 */
export function isExpiredAt(terms: MandateTerms, now: Date): boolean {
  return now.getTime() > terms.validTo.getTime();
}

/** Before its validity window has opened. Distinct from expired. */
export function isNotYetValidAt(terms: MandateTerms, now: Date): boolean {
  return now.getTime() < terms.validFrom.getTime();
}

/**
 * Usable right now: not revoked, and inside its validity dates.
 *
 * Deliberately does NOT consider the time-of-day window, the merchant
 * allowlist or any limit - those are individual policy rules in Phase 4, each
 * of which must produce its own Signal -> Rule -> Verdict record. Collapsing
 * them into one boolean here would destroy the explainability the product is
 * built on.
 */
export function isUsableAt(mandateWithVersion: MandateWithVersion, now: Date): boolean {
  const { mandate, version } = mandateWithVersion;

  return (
    mandate.status === 'active' &&
    !isExpiredAt(version.terms, now) &&
    !isNotYetValidAt(version.terms, now)
  );
}
