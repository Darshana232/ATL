/**
 * Policy engine types.
 *
 * This whole directory is PURE. Nothing here imports `pg`, reads a clock or
 * makes a network call. If a file in src/policy/ ever imports a database
 * driver, something has gone wrong.
 */
import type { Paise } from '../money.js';
import type {
  Mandate,
  MandateVersion,
  PaymentMethod,
  Weekday,
} from '../domain/mandate.js';

/**
 * The engine's answer.
 *
 * FLAG means "allowed, but recorded as suspicious for human review" - the STR
 * candidate path. It is not a soft block: the payment proceeds.
 */
export type Verdict = 'PASS' | 'FLAG' | 'BLOCK';

/**
 * A single rule's outcome. SKIP is a real result, not an absence: a velocity
 * rule cannot run when a mandate sets no velocity limit, and silence would be
 * indistinguishable from a pass.
 *
 * Returning SKIP rather than throwing is what makes the engine a TOTAL
 * function. An engine that throws fails open or closed depending on the
 * caller's catch block - which is the worst possible place for a security
 * decision to live.
 */
export type RuleVerdict = Verdict | 'SKIP';

/**
 * The explainability record: Signal -> Rule -> Evaluation -> Verdict -> Reason,
 * as a TYPED STRUCTURE PRODUCED BY CODE.
 *
 * Never prose from a language model. A model can produce plausible text about a
 * decision it did not make; only the rule that actually fired knows the
 * numbers.
 */
export interface RuleEvaluation {
  /** Stable machine identifier, e.g. MANDATE_PER_TXN_LIMIT. Reports group by it. */
  readonly ruleCode: string;
  /** Execution order, so the trail can be replayed exactly as it ran. */
  readonly sequence: number;
  readonly verdict: RuleVerdict;
  /** What was observed. */
  readonly signal: string;
  /** What the mandate permitted. */
  readonly expected: string;
  /** What the request contained. */
  readonly actual: string;
  /** One sentence, containing the numbers. */
  readonly reason: string;
  /** Machine-readable amounts for money rules, so reports need not parse English. */
  readonly observedPaise: Paise | null;
  readonly limitPaise: Paise | null;
}

/** The payment being attempted. */
export interface AuthorizationAttempt {
  readonly amountPaise: Paise;
  readonly merchantId: string;
  /** ISO 18245 code, resolved by the caller from the merchants table. */
  readonly merchantMcc: string;
  readonly paymentMethod: PaymentMethod;
}

/**
 * What has already been spent, supplied by the caller.
 *
 * The engine does NOT compute this - that is a database query, and computing it
 * here would make the engine impure. The consequence is that the engine trusts
 * the snapshot: Phase 5 must produce it under the row lock, or the window limit
 * is only as accurate as whatever was passed in. Recorded as debt in
 * PHASE_04 §12.
 */
export interface SpendSnapshot {
  readonly windowStart: Date;
  readonly windowEnd: Date;
  readonly spentInWindowPaise: Paise;
  /** COMPLETED transactions in the trailing hour, not counting this attempt. */
  readonly txnsInLastHour: number;
}

/**
 * Advisory input from a risk provider.
 *
 * May raise a FLAG. Can NEVER produce a BLOCK, and can never rescue one.
 * Authorization is deterministic and explainable; risk scoring is
 * probabilistic and empirical. Letting a score block would make our verdicts
 * irreproducible.
 */
export interface RiskInput {
  readonly provider: string;
  /** 0-100. */
  readonly score: number;
  readonly band: 'LOW' | 'MEDIUM' | 'HIGH';
  readonly reasons: readonly string[];
}

export interface EvaluationInput {
  readonly mandate: Mandate;
  readonly version: MandateVersion;
  readonly attempt: AuthorizationAttempt;
  readonly spend: SpendSnapshot;
  /**
   * The clock reading, PASSED IN.
   *
   * This single parameter is what makes the engine deterministic, replayable
   * and testable without fake timers. Feeding a past decision's exact inputs
   * back in must reproduce its verdict.
   */
  readonly now: Date;
  /** Null when no provider answered - distinct from a score of 0. */
  readonly risk: RiskInput | null;
}

export interface Decision {
  readonly verdict: Verdict;
  /** The first blocking rule's reason. Contains numbers. */
  readonly reason: string;
  /**
   * Which rule SET produced this verdict.
   *
   * The mandate is versioned already, but a decision is only re-explainable if
   * the RULES are recoverable too. "Why was this allowed in September?" is
   * unanswerable after the rules change unless we recorded which rules ran.
   */
  readonly engineVersion: string;
  /** Every rule that ran, in order - including the ones that passed. */
  readonly evaluations: readonly RuleEvaluation[];
  readonly evaluatedAt: Date;
}

/** A rule is a pure function from the whole input to one evaluation. */
export type Rule = (input: EvaluationInput) => RuleEvaluation;

export type { Mandate, MandateVersion, PaymentMethod, Weekday };
