/**
 * The rules.
 *
 * Each is a PURE FUNCTION from the whole evaluation input to exactly one
 * RuleEvaluation. No rule reads a clock, touches a database, or knows about
 * any other rule.
 *
 * COMPARISON OPERATORS ARE STATED EXPLICITLY beside each numeric rule, because
 * the opposite choice is equally implementable and the difference is real
 * money. Amounts use `>` (a ₹2,000 limit permits exactly ₹2,000 - the everyday
 * reading of the word). Velocity uses `>=` (if the limit is 5 per hour and 5
 * have already completed, this attempt is the SIXTH).
 */
import { formatPaise, toPaise, type Paise } from '../money.js';
import { isExpiredAt, isNotYetValidAt } from '../domain/mandate.js';
import { isInsideWindow, localMomentIn } from './time-window.js';
import type { Rule, RuleEvaluation, RuleVerdict } from './types.js';

interface EvaluationParts {
  readonly signal: string;
  readonly expected: string;
  readonly actual: string;
  readonly reason: string;
  readonly observedPaise?: Paise | null;
  readonly limitPaise?: Paise | null;
}

function evaluation(
  ruleCode: string,
  sequence: number,
  verdict: RuleVerdict,
  parts: EvaluationParts,
): RuleEvaluation {
  return {
    ruleCode,
    sequence,
    verdict,
    signal: parts.signal,
    expected: parts.expected,
    actual: parts.actual,
    reason: parts.reason,
    observedPaise: parts.observedPaise ?? null,
    limitPaise: parts.limitPaise ?? null,
  };
}

/* ------------------------------------------------------------------------ */
/* 1. Is the mandate still in force at all?                                 */
/* ------------------------------------------------------------------------ */

export const mandateRevoked: Rule = ({ mandate }) => {
  const revoked = mandate.status === 'revoked';

  return evaluation('MANDATE_REVOKED', 1, revoked ? 'BLOCK' : 'PASS', {
    signal: `mandate status is ${mandate.status}`,
    expected: 'active',
    actual: mandate.status,
    reason: revoked
      ? `This mandate was revoked${mandate.revokedAt === null ? '' : ` on ${mandate.revokedAt.toISOString()}`}` +
        `${mandate.revokedReason === null ? '' : ` (${mandate.revokedReason})`}. Revocation is permanent.`
      : 'The mandate is active.',
  });
};

export const mandateNotYetValid: Rule = ({ version, now }) => {
  const tooEarly = isNotYetValidAt(version.terms, now);

  return evaluation('MANDATE_NOT_YET_VALID', 2, tooEarly ? 'BLOCK' : 'PASS', {
    signal: `now is ${now.toISOString()}`,
    expected: `at or after ${version.terms.validFrom.toISOString()}`,
    actual: now.toISOString(),
    // Kept separate from expiry so the REASON is right in each case. Collapsing
    // both into "invalid" would make the explanation wrong half the time, and
    // the reason is the product.
    reason: tooEarly
      ? `This mandate does not take effect until ${version.terms.validFrom.toISOString()}.`
      : 'The mandate has taken effect.',
  });
};

export const mandateExpiry: Rule = ({ version, now }) => {
  const expired = isExpiredAt(version.terms, now);

  return evaluation('MANDATE_EXPIRY', 3, expired ? 'BLOCK' : 'PASS', {
    signal: `now is ${now.toISOString()}`,
    expected: `at or before ${version.terms.validTo.toISOString()}`,
    actual: now.toISOString(),
    reason: expired
      ? `This mandate expired on ${version.terms.validTo.toISOString()}.`
      : `The mandate is valid until ${version.terms.validTo.toISOString()}.`,
  });
};

/* ------------------------------------------------------------------------ */
/* 2. Amounts                                                               */
/* ------------------------------------------------------------------------ */

export const perTransactionLimit: Rule = ({ version, attempt }) => {
  const limit = version.terms.perTxnLimitPaise;
  const amount = attempt.amountPaise;

  // `>` not `>=`: a limit of ₹2,000 permits exactly ₹2,000.
  const exceeds = amount > limit;
  const overBy = amount - limit;

  return evaluation('MANDATE_PER_TXN_LIMIT', 4, exceeds ? 'BLOCK' : 'PASS', {
    signal: `requested ${amount} paise`,
    expected: `<= ${limit} paise`,
    actual: `${amount} paise`,
    reason: exceeds
      ? `Requested ${formatPaise(amount)} exceeds the ${formatPaise(limit)} ` +
        `per-transaction limit by ${formatPaise(overBy)}.`
      : `Requested ${formatPaise(amount)} is within the ${formatPaise(limit)} per-transaction limit.`,
    observedPaise: amount,
    limitPaise: limit,
  });
};

export const windowSpendLimit: Rule = ({ version, attempt, spend }) => {
  const limit = version.terms.windowLimitPaise;
  const already = spend.spentInWindowPaise;
  const total = toPaise(already + attempt.amountPaise);

  // `>` not `>=`, for the same reason as the per-transaction limit.
  const exceeds = total > limit;
  const overBy = total - limit;
  const window = version.terms.windowKind;

  return evaluation('MANDATE_WINDOW_LIMIT', 5, exceeds ? 'BLOCK' : 'PASS', {
    signal: `${already} paise already spent this ${window}, requesting ${attempt.amountPaise} more`,
    expected: `<= ${limit} paise per ${window}`,
    actual: `${total} paise`,
    reason: exceeds
      ? `${formatPaise(already)} already spent this ${window} plus ${formatPaise(attempt.amountPaise)} ` +
        `would reach ${formatPaise(total)}, exceeding the ${formatPaise(limit)} ${window}ly limit ` +
        `by ${formatPaise(overBy)}.`
      : `${formatPaise(total)} of the ${formatPaise(limit)} ${window}ly limit would be used ` +
        `(${formatPaise(toPaise(limit - total))} remaining).`,
    observedPaise: total,
    limitPaise: limit,
  });
};

/* ------------------------------------------------------------------------ */
/* 3. Scope: who and what                                                   */
/* ------------------------------------------------------------------------ */

export const merchantAllowlist: Rule = ({ version, attempt }) => {
  const allowlist = version.merchantAllowlist;
  const allowed = allowlist.includes(attempt.merchantId);

  // DENY BY DEFAULT. An empty allowlist permits NO merchant. Reading empty as
  // "no restriction" would turn an unfinished mandate into an unlimited one -
  // every ambiguous absence in an authorization system must resolve to LESS
  // authority, never more.
  const reason = allowed
    ? `${attempt.merchantId} is on this mandate's merchant allowlist.`
    : allowlist.length === 0
      ? `This mandate has an empty merchant allowlist, so no merchant is permitted.`
      : `${attempt.merchantId} is not on this mandate's merchant allowlist ` +
        `(${allowlist.join(', ')}).`;

  return evaluation('MERCHANT_ALLOWLIST', 6, allowed ? 'PASS' : 'BLOCK', {
    signal: `merchant is ${attempt.merchantId}`,
    expected: allowlist.length === 0 ? '(empty allowlist: nothing permitted)' : allowlist.join(', '),
    actual: attempt.merchantId,
    reason,
  });
};

export const categoryBlocklist: Rule = ({ version, attempt }) => {
  const blocked = version.terms.blockedMccs.includes(attempt.merchantMcc);

  // Keyed on MCC rather than a product name or category string: a four-digit
  // code assigned to the merchant is far harder to game than free text an
  // agent or a merchant can write.
  return evaluation('CATEGORY_BLOCKLIST', 7, blocked ? 'BLOCK' : 'PASS', {
    signal: `merchant category code is ${attempt.merchantMcc}`,
    expected:
      version.terms.blockedMccs.length === 0
        ? '(no categories blocked)'
        : `not one of ${version.terms.blockedMccs.join(', ')}`,
    actual: attempt.merchantMcc,
    reason: blocked
      ? `Merchant category ${attempt.merchantMcc} is blocked by this mandate.`
      : `Merchant category ${attempt.merchantMcc} is not blocked by this mandate.`,
  });
};

export const paymentMethodAllowed: Rule = ({ version, attempt }) => {
  const allowed = version.terms.paymentMethods.includes(attempt.paymentMethod);

  return evaluation('PAYMENT_METHOD_ALLOWED', 10, allowed ? 'PASS' : 'BLOCK', {
    signal: `payment method is ${attempt.paymentMethod}`,
    expected: version.terms.paymentMethods.join(', '),
    actual: attempt.paymentMethod,
    reason: allowed
      ? `${attempt.paymentMethod} is a permitted payment method for this mandate.`
      : `${attempt.paymentMethod} is not a permitted payment method for this mandate ` +
        `(${version.terms.paymentMethods.join(', ')}).`,
  });
};

/* ------------------------------------------------------------------------ */
/* 4. Context: when and how often                                           */
/* ------------------------------------------------------------------------ */

export const timeWindow: Rule = ({ version, now }) => {
  const { timezone, windowStartHour, windowEndHour, allowedWeekdays } = version.terms;

  const moment = localMomentIn(now, timezone);
  const inside = isInsideWindow(moment, windowStartHour, windowEndHour, allowedWeekdays);

  const localText = `${String(moment.hour).padStart(2, '0')}:00 ${moment.weekday}`;
  const windowText =
    `${String(windowStartHour).padStart(2, '0')}:00-${String(windowEndHour).padStart(2, '0')}:00 ` +
    `${allowedWeekdays.join('/')} (${timezone})`;

  // Both the hour AND the weekday are computed in the mandate's timezone. The
  // weekday genuinely changes with the zone - 18:30Z is Monday in UTC and
  // Tuesday in Asia/Kolkata - so a UTC weekday check would apply the wrong
  // day's rule for several hours every day.
  return evaluation('TIME_WINDOW', 8, inside ? 'PASS' : 'BLOCK', {
    signal: `local time is ${localText}`,
    expected: windowText,
    actual: localText,
    reason: inside
      ? `${localText} is inside the permitted window ${windowText}.`
      : `${localText} is outside the permitted window ${windowText}.`,
  });
};

export const velocityLimit: Rule = ({ version, spend }) => {
  const limit = version.terms.maxTxnPerHour;
  const completed = spend.txnsInLastHour;

  // `>=` not `>`, and the asymmetry with the amount rules is deliberate:
  // txnsInLastHour counts COMPLETED transactions, not including this attempt.
  // If the limit is 5 and 5 have completed, this one would be the sixth.
  const exceeds = completed >= limit;

  return evaluation('VELOCITY_LIMIT', 9, exceeds ? 'BLOCK' : 'PASS', {
    signal: `${completed} transactions in the last hour`,
    expected: `< ${limit} per hour`,
    actual: `${completed}`,
    reason: exceeds
      ? `${completed} transaction${completed === 1 ? '' : 's'} already completed in the last hour, ` +
        `reaching this mandate's limit of ${limit} per hour.`
      : `${completed} of ${limit} permitted transactions used in the last hour.`,
  });
};

/* ------------------------------------------------------------------------ */
/* 5. Informational and advisory - neither can block                        */
/* ------------------------------------------------------------------------ */

/**
 * NPCI's AFA-exemption ceiling (circular UPI/OC-151A, 14 Dec 2023).
 *
 * ALWAYS PASSES. It governs whether a UPI PIN is required, on a rail we do not
 * operate, so we RECORD and DISPLAY it - we never enforce it.
 *
 * It exists as its own rule specifically because the research treats this
 * threshold as a mandate spending cap. It is not: MANDATE_PER_TXN_LIMIT is
 * user-set and enforced by us; this is regulatory and enforced by the rail.
 * Two different rules with two different owners, and conflating them is how
 * you end up enforcing someone else's threshold as if it were your own.
 */
export const afaExemptionThreshold: Rule = ({ version, attempt }) => {
  const threshold = version.terms.afaExemptionThresholdPaise;
  const above = attempt.amountPaise > threshold;

  return evaluation('AFA_EXEMPTION_THRESHOLD', 11, 'PASS', {
    signal: `requested ${attempt.amountPaise} paise`,
    expected: `informational only (AFA-exempt ceiling ${threshold} paise)`,
    actual: `${attempt.amountPaise} paise`,
    reason: above
      ? `${formatPaise(attempt.amountPaise)} is above the ${formatPaise(threshold)} AFA-exempt ` +
        `ceiling, so the rail may require additional authentication. Recorded, not enforced here.`
      : `${formatPaise(attempt.amountPaise)} is within the ${formatPaise(threshold)} AFA-exempt ceiling.`,
    observedPaise: attempt.amountPaise,
    limitPaise: threshold,
  });
};

/**
 * Advisory risk input.
 *
 * May raise a FLAG. Can NEVER produce a BLOCK, and can never rescue one.
 * Enforced here in code AND by `CHECK (is_advisory)` in the schema: the code
 * expresses the intent, the constraint means changing it requires a migration
 * and a review rather than one line in a service.
 */
export const riskSignal: Rule = ({ risk }) => {
  if (risk === null) {
    // SKIP, not PASS: "no provider answered" is different from "a provider said
    // this is fine", and an audit trail must keep them distinguishable.
    return evaluation('RISK_SIGNAL', 12, 'SKIP', {
      signal: 'no risk signal available',
      expected: 'advisory input, if any provider responded',
      actual: 'none',
      reason: 'No risk provider returned a signal for this request.',
    });
  }

  const flagged = risk.band === 'HIGH';

  return evaluation('RISK_SIGNAL', 12, flagged ? 'FLAG' : 'PASS', {
    signal: `risk score ${risk.score} (${risk.band}) from ${risk.provider}`,
    expected: 'advisory only; cannot block',
    actual: `${risk.score} (${risk.band})`,
    reason: flagged
      ? `Risk provider ${risk.provider} scored this ${risk.score}/100 (${risk.band})` +
        `${risk.reasons.length === 0 ? '' : `: ${risk.reasons.join('; ')}`}. ` +
        `Flagged for human review; the payment is not blocked by this signal.`
      : `Risk provider ${risk.provider} scored this ${risk.score}/100 (${risk.band}).`,
  });
};

/**
 * Execution order, and it is a deliberate choice rather than an accident.
 *
 * Identity and validity first, then amounts, then scope, then context. The
 * headline `reason` on a Decision is the FIRST blocking rule's reason, so
 * ordering determines which failure a user is told about when several apply.
 * A revoked mandate should say "revoked", not "outside your time window".
 */
export const ALL_RULES: readonly Rule[] = [
  mandateRevoked,
  mandateNotYetValid,
  mandateExpiry,
  perTransactionLimit,
  windowSpendLimit,
  merchantAllowlist,
  categoryBlocklist,
  timeWindow,
  velocityLimit,
  paymentMethodAllowed,
  afaExemptionThreshold,
  riskSignal,
];
