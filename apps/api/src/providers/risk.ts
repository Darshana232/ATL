/**
 * Risk scoring - ADVISORY INPUT, NEVER AUTHORITY.
 *
 * Fraud detection and authorization are DIFFERENT PROBLEMS with different
 * correctness criteria:
 *
 *   authorization  "was this permitted?"   deterministic, explainable,
 *                                          reproducible, auditable
 *   fraud scoring  "was this suspicious?"  probabilistic, empirical,
 *                                          tuned against outcomes
 *
 * Merging them would make our verdicts unexplainable and our fraud detection
 * untestable. So a score may raise a FLAG; it can never override a BLOCK and it
 * can never manufacture a PASS. That constraint is enforced in three places:
 * the `riskSignal` rule (policy/rules.ts), the aggregation order
 * (policy/engine.ts) and `CHECK (is_advisory)` in migration 0004.
 *
 * ============================ HONEST LABELLING ============================
 * The "AFRI" risk service referenced in the research DOES NOT EXIST - it is a
 * proposal document in the same folder, with no code and no endpoint (see
 * RESEARCH_REALITY_CHECK item 7 and ADR-0010). The only implementation here is
 * MOCKED FOR MVP and says so on every row it produces.
 * ==========================================================================
 */
import { createHash } from 'node:crypto';
import type { RiskInput } from '../policy/types.js';

export interface RiskQuery {
  readonly mandateId: string;
  readonly agentId: string;
  readonly merchantId: string;
  readonly merchantMcc: string;
  readonly amountPaise: number;
  readonly spentInWindowPaise: number;
  readonly txnsInLastHour: number;
  readonly now: Date;
}

export interface RiskProvider {
  readonly name: string;
  /**
   * Returns null when no signal is available - which is DIFFERENT from a score
   * of zero and must stay distinguishable. "We did not ask" and "we asked and
   * it looked clean" are not the same fact in an audit.
   */
  score(query: RiskQuery): Promise<RiskInput | null>;
}

function band(score: number): 'LOW' | 'MEDIUM' | 'HIGH' {
  if (score >= 70) return 'HIGH';
  if (score >= 40) return 'MEDIUM';
  return 'LOW';
}

/**
 * Deterministic simulated scorer.
 *
 * DETERMINISTIC ON PURPOSE, even though real fraud models are not. Two reasons:
 * a demo must be reproducible, and a test that asserts on a random score is a
 * test that fails on Tuesdays.
 *
 * IN-PROCESS ON PURPOSE. It makes no network call, so the authorization path
 * has NO third-party dependency (ADR-0013). A compliance verdict must not
 * depend on someone else's uptime: if the dependency is down, blocking every
 * payment and allowing every payment are both wrong answers.
 *
 * The factors below are plausible-looking heuristics, not a trained model. They
 * exist to make the FLAG path demonstrable and the STR-candidate pipeline
 * testable, and they are labelled as simulation everywhere they surface.
 */
export class MockRiskProvider implements RiskProvider {
  readonly name = 'mock';

  async score(query: RiskQuery): Promise<RiskInput> {
    const reasons: string[] = [];
    let score = 0;

    // A large single amount relative to typical consumer spend.
    if (query.amountPaise >= 5_000_00) {
      score += 25;
      reasons.push('amount is unusually large for this mandate type');
    }

    // Bursts. Note this is ADVISORY - the deterministic VELOCITY_LIMIT rule is
    // what actually blocks; this only notices the shape.
    if (query.txnsInLastHour >= 3) {
      score += 20;
      reasons.push(`${query.txnsInLastHour} transactions already in the last hour`);
    }

    // Late-night activity, evaluated in UTC here purely as a simulated signal.
    const hour = query.now.getUTCHours();
    if (hour >= 19 || hour < 2) {
      score += 15;
      reasons.push('transaction outside typical daytime hours (UTC)');
    }

    // Higher-risk merchant categories under ISO 18245.
    if (['5921', '7995', '6051', '4829'].includes(query.merchantMcc)) {
      score += 30;
      reasons.push(`merchant category ${query.merchantMcc} is in a higher-risk class`);
    }

    // A stable per-mandate jitter so different mandates do not all score
    // identically, without introducing randomness.
    const jitter =
      createHash('sha256').update(`${query.mandateId}:${query.merchantId}`).digest()[0]! % 10;
    score = Math.min(100, score + jitter);

    if (reasons.length === 0) reasons.push('no elevated-risk factors observed');

    return {
      provider: this.name,
      score,
      band: band(score),
      reasons: Object.freeze(reasons),
    };
  }
}

/**
 * A provider that always declines to answer.
 *
 * Exists so tests can prove the system behaves correctly with NO risk signal -
 * `risk: null`, RISK_SIGNAL rule SKIPs, and the verdict is unaffected. A
 * degraded risk provider must never change a compliance outcome.
 */
export class NullRiskProvider implements RiskProvider {
  readonly name = 'mock';
  async score(): Promise<null> { return null; }
}
