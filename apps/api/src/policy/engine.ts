/**
 * The policy engine.
 *
 * ONE pure function. Given a mandate version, an attempted payment, a spend
 * snapshot, a clock reading and an optional risk signal, it returns a verdict
 * and the complete per-rule breakdown behind it.
 *
 * This is the heart of the product, and its most important property is what it
 * does NOT do: no database, no clock, no network, no language model. Not one
 * line of this file imports an AI SDK, and `Decision` has no field a model
 * could populate.
 */
import { ALL_RULES } from './rules.js';
import type { Decision, EvaluationInput, RuleEvaluation, Verdict } from './types.js';

/**
 * Which rule SET produced a verdict.
 *
 * The mandate is versioned; the rules must be too. "Why was this allowed in
 * September?" is unanswerable after the rules change unless the decision
 * records which rules ran. Bump this whenever a rule's behaviour changes.
 *
 * Debt (PHASE_04 §12): nothing forces this to change when a rule does. A test
 * comparing a hash of the rule set would.
 */
export const ENGINE_VERSION = 'engine-v2';

/*
 * engine-v1 -> engine-v2 (Phase 5): added MANDATE_AGENT_MATCH.
 *
 * The bump is the mechanism working as designed. Decisions recorded under v1
 * stay explainable against the twelve rules that actually ran; nobody has to
 * pretend a thirteenth rule was applied retroactively.
 */

/**
 * Combine per-rule outcomes into one verdict.
 *
 * Precedence: any BLOCK wins; otherwise any FLAG; otherwise PASS. SKIP never
 * contributes - it means the rule did not apply.
 *
 * Order-independent by construction, so the verdict cannot change if rules are
 * reordered. Only the human-readable `reason` depends on order.
 */
function aggregate(evaluations: readonly RuleEvaluation[]): Verdict {
  let sawFlag = false;

  for (const item of evaluations) {
    switch (item.verdict) {
      case 'BLOCK':
        // Early return is safe HERE because every rule has already run - we are
        // summarising results, not deciding whether to compute them.
        return 'BLOCK';
      case 'FLAG':
        sawFlag = true;
        break;
      case 'PASS':
      case 'SKIP':
        break;
      default: {
        // Exhaustiveness check. If a fourth verdict is ever added, this line
        // becomes a COMPILE ERROR here and everywhere else that handles
        // verdicts - rather than a silently unhandled case at runtime.
        const unreachable: never = item.verdict;
        throw new Error(`unhandled rule verdict: ${String(unreachable)}`);
      }
    }
  }

  return sawFlag ? 'FLAG' : 'PASS';
}

/**
 * The headline reason: the FIRST blocking rule's, else the first flagging
 * rule's, else a summary.
 *
 * One clear sentence is actionable; five are noise. The full breakdown stays
 * available in `evaluations` for anyone who wants it - so this is a
 * presentation choice, not a loss of information.
 */
function headlineReason(evaluations: readonly RuleEvaluation[], verdict: Verdict): string {
  switch (verdict) {
    case 'BLOCK':
      return evaluations.find((item) => item.verdict === 'BLOCK')?.reason ?? 'Blocked.';
    case 'FLAG':
      return evaluations.find((item) => item.verdict === 'FLAG')?.reason ?? 'Flagged for review.';
    case 'PASS': {
      const checked = evaluations.filter((item) => item.verdict !== 'SKIP').length;
      return `Authorized: all ${checked} applicable policy checks passed.`;
    }
    default: {
      const unreachable: never = verdict;
      throw new Error(`unhandled verdict: ${String(unreachable)}`);
    }
  }
}

/**
 * Evaluate an attempted payment against a mandate version.
 *
 * EVERY RULE RUNS. None is skipped, even after one has already blocked.
 *
 * That is deliberate and slightly counterintuitive. Short-circuiting on the
 * first BLOCK would be marginally faster and would leave the audit record
 * unable to show that the other checks were PERFORMED - and "did you check the
 * merchant?" is exactly what an auditor asks. It also means a user sees every
 * reason at once rather than discovering them one failed retry at a time.
 *
 * The cost is about eleven extra integer comparisons.
 */
export function evaluate(input: EvaluationInput): Decision {
  const evaluations = ALL_RULES.map((rule) => rule(input));

  const verdict = aggregate(evaluations);

  return {
    verdict,
    reason: headlineReason(evaluations, verdict),
    engineVersion: ENGINE_VERSION,
    evaluations,
    // `now` is echoed rather than read from the clock, so a replayed evaluation
    // reproduces the original decision exactly.
    evaluatedAt: input.now,
  };
}
