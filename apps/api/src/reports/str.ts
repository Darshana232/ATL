/**
 * STR (Suspicious Transaction Report) drafting.
 *
 * ========================== WHAT WE CANNOT DO ===========================
 * An STR is a LEGAL FILING made through FIU-IND's FINnet portal by REGISTERED
 * REPORTING ENTITIES under the PMLA. We are not one. We have no FINnet access
 * and no authorisation.
 *
 * The research claims this system can "auto-file an STR with FIU-IND". It
 * cannot, and the schema will not let it: migration 0010's status CHECK has no
 * 'filed' value, so no code path can set one.
 *
 * The honest workflow stops one step earlier and hands a human a draft:
 *
 *   detection -> candidate -> DRAFT -> human review -> READY FOR FILING
 *
 * See RESEARCH_REALITY_CHECK item 6 and CLAUDE.md section 13.
 * ========================================================================
 *
 * DETECTION IS DETERMINISTIC, and it is NOT fraud detection. It selects
 * decisions that tripped a stated rule. Reproducible, explainable, and
 * defensible to a reviewer who asks "why is this one here?" - which is the
 * question that matters, because a human has to sign it.
 */
import type pg from 'pg';
import { formatPaise } from '../money.js';

/** Why a transaction became a candidate. Each maps to a stated rule. */
export type CandidateReason =
  | 'MANDATE_LIMIT_BREACH'
  | 'BLOCKED_CATEGORY_ATTEMPT'
  | 'REPEATED_BLOCKS'
  | 'HIGH_RISK_BAND'
  | 'AGENT_IDENTITY_MISMATCH'
  | 'AUTHENTICATION_FAILURES';

export interface StrCandidate {
  readonly reason: CandidateReason;
  readonly title: string;
  /** Written by code, from the actual numbers. Never model prose. */
  readonly narrative: string;
  readonly occurredAt: string;
  readonly mandateId: string | null;
  readonly agentId: string | null;
  readonly decisionId: string | null;
  readonly amountPaise: number | null;
  readonly ruleCode: string | null;
  /** Audit event ids supporting this candidate, so a reviewer can verify it. */
  readonly evidenceRefs: readonly string[];
}

export interface StrDraft {
  readonly kind: 'str_draft';
  readonly status: 'DRAFT';
  readonly generatedAt: string;
  readonly periodStart: string;
  readonly periodEnd: string;
  readonly candidateCount: number;
  readonly candidates: readonly StrCandidate[];
  /** FIU-IND-STYLE fields. Style, not a filing format we are certified against. */
  readonly reportingEntity: {
    readonly name: string;
    readonly registrationStatus: string;
    readonly finnetAccess: string;
  };
  readonly caveat: string;
  readonly nextStep: string;
}

export const STR_CAVEAT =
  'DRAFT — HUMAN REVIEW REQUIRED. This is NOT a filed Suspicious Transaction ' +
  'Report. FIU-IND filing is performed through the FINnet portal by registered ' +
  'reporting entities under the PMLA; ATL-India is not a registered reporting ' +
  'entity, holds no FINnet access, and cannot file. This document is a ' +
  'machine-generated candidate summary intended for review by a qualified ' +
  'compliance officer, who decides whether anything is filed and files it ' +
  'themselves. The field layout is FIU-IND-STYLE for familiarity only and has ' +
  'not been validated against any filing schema.';

interface CandidateRow {
  decision_id: string; mandate_id: string; agent_id: string;
  amount_paise: string; rule_code: string; reason: string;
  evaluated_at: Date; verdict: string; risk_score: number | null;
}

/**
 * Decisions that BLOCKED on a limit or a prohibited category.
 *
 * Rides `rule_evaluations_by_rule_verdict_idx` — `(rule_code, verdict,
 * created_at DESC)` — built in Phase 2 for exactly this report, before there
 * was any report to run it.
 */
const LIMIT_BREACH_SQL = `
  SELECT d.id AS decision_id, d.mandate_id, r.agent_id, r.amount_paise,
         re.rule_code, re.reason, d.evaluated_at, d.verdict, d.risk_score
    FROM rule_evaluations re
    JOIN decisions d ON d.id = re.decision_id
    JOIN authorization_requests r ON r.id = d.authorization_request_id
   WHERE re.verdict = 'BLOCK'
     AND re.rule_code = ANY($3)
     AND d.evaluated_at >= $1 AND d.evaluated_at < $2
   ORDER BY d.evaluated_at DESC
   LIMIT 200`;

export interface StrOptions {
  readonly periodStart?: Date;
  readonly periodEnd?: Date;
  readonly now?: Date;
}

export async function buildStrDraft(
  client: pg.PoolClient | pg.Pool,
  options: StrOptions = {},
): Promise<StrDraft> {
  const now = options.now ?? new Date();
  const periodEnd = options.periodEnd ?? now;
  const periodStart =
    options.periodStart ?? new Date(periodEnd.getTime() - 30 * 24 * 60 * 60 * 1000);

  const candidates: StrCandidate[] = [];

  /* --- 1. Limit breaches -------------------------------------------- */
  const limitBreaches = await client.query<CandidateRow>(LIMIT_BREACH_SQL, [
    periodStart, periodEnd,
    ['MANDATE_PER_TXN_LIMIT', 'MANDATE_WINDOW_LIMIT', 'VELOCITY_LIMIT'],
  ]);

  for (const row of limitBreaches.rows) {
    candidates.push({
      reason: 'MANDATE_LIMIT_BREACH',
      title: `Attempted payment exceeding an authorised limit (${row.rule_code})`,
      // The narrative carries the NUMBERS, because a reviewer cannot assess
      // "a limit was exceeded" and can assess "₹6,200 against a ₹2,000 limit".
      narrative:
        `Agent ${row.agent_id} attempted ${formatPaise(Number(row.amount_paise))} ` +
        `under mandate ${row.mandate_id} and was blocked by ${row.rule_code}. ` +
        `Engine reason: ${row.reason}`,
      occurredAt: row.evaluated_at.toISOString(),
      mandateId: row.mandate_id, agentId: row.agent_id,
      decisionId: row.decision_id, amountPaise: Number(row.amount_paise),
      ruleCode: row.rule_code, evidenceRefs: [row.decision_id],
    });
  }

  /* --- 2. Prohibited categories and merchants ------------------------ */
  const categoryAttempts = await client.query<CandidateRow>(LIMIT_BREACH_SQL, [
    periodStart, periodEnd, ['CATEGORY_BLOCKLIST', 'MERCHANT_ALLOWLIST'],
  ]);

  for (const row of categoryAttempts.rows) {
    candidates.push({
      reason: 'BLOCKED_CATEGORY_ATTEMPT',
      title: 'Attempted payment to a prohibited merchant or category',
      narrative:
        `Agent ${row.agent_id} attempted ${formatPaise(Number(row.amount_paise))} ` +
        `at a merchant this mandate does not permit. Engine reason: ${row.reason}`,
      occurredAt: row.evaluated_at.toISOString(),
      mandateId: row.mandate_id, agentId: row.agent_id,
      decisionId: row.decision_id, amountPaise: Number(row.amount_paise),
      ruleCode: row.rule_code, evidenceRefs: [row.decision_id],
    });
  }

  /* --- 3. Agent identity mismatch ------------------------------------ */
  // An agent presenting a mandate granted to a DIFFERENT agent. Not a limit
  // breach - a boundary probe, and a reviewer should see it separately.
  const identityAttempts = await client.query<CandidateRow>(LIMIT_BREACH_SQL, [
    periodStart, periodEnd, ['MANDATE_AGENT_MATCH'],
  ]);

  for (const row of identityAttempts.rows) {
    candidates.push({
      reason: 'AGENT_IDENTITY_MISMATCH',
      title: 'Agent attempted to spend against a mandate granted to another agent',
      narrative:
        `Agent ${row.agent_id} presented mandate ${row.mandate_id}, which ` +
        `authorises a different agent. Engine reason: ${row.reason}`,
      occurredAt: row.evaluated_at.toISOString(),
      mandateId: row.mandate_id, agentId: row.agent_id,
      decisionId: row.decision_id, amountPaise: Number(row.amount_paise),
      ruleCode: row.rule_code, evidenceRefs: [row.decision_id],
    });
  }

  /* --- 4. Repeated blocks by one agent ------------------------------- */
  // A pattern, not a single event: one block is a mistake, twenty in a day is
  // a probe.
  const repeated = await client.query<{
    agent_id: string; mandate_id: string; blocks: string; last_at: Date;
  }>(
    `SELECT r.agent_id, d.mandate_id, count(*)::bigint AS blocks, max(d.evaluated_at) AS last_at
       FROM decisions d
       JOIN authorization_requests r ON r.id = d.authorization_request_id
      WHERE d.verdict = 'BLOCK' AND d.evaluated_at >= $1 AND d.evaluated_at < $2
      GROUP BY r.agent_id, d.mandate_id
     HAVING count(*) >= 5
      ORDER BY count(*) DESC
      LIMIT 50`,
    [periodStart, periodEnd],
  );

  for (const row of repeated.rows) {
    candidates.push({
      reason: 'REPEATED_BLOCKS',
      title: 'Repeated blocked authorization attempts',
      narrative:
        `Agent ${row.agent_id} was blocked ${row.blocks} times against mandate ` +
        `${row.mandate_id} in this period. Repeated refusal may indicate a ` +
        `misconfigured agent or deliberate probing of the limits.`,
      occurredAt: row.last_at.toISOString(),
      mandateId: row.mandate_id, agentId: row.agent_id,
      decisionId: null, amountPaise: null, ruleCode: null, evidenceRefs: [],
    });
  }

  /* --- 5. High risk band --------------------------------------------- */
  const highRisk = await client.query<{
    decision_id: string; mandate_id: string; agent_id: string;
    amount_paise: string; score: number; reasons: string[]; evaluated_at: Date;
  }>(
    `SELECT d.id AS decision_id, d.mandate_id, r.agent_id, r.amount_paise,
            rs.score, rs.reasons, d.evaluated_at
       FROM risk_signals rs
       JOIN authorization_requests r ON r.id = rs.authorization_request_id
       JOIN decisions d ON d.authorization_request_id = r.id
      WHERE rs.band = 'HIGH' AND d.evaluated_at >= $1 AND d.evaluated_at < $2
      ORDER BY rs.score DESC
      LIMIT 50`,
    [periodStart, periodEnd],
  );

  for (const row of highRisk.rows) {
    candidates.push({
      reason: 'HIGH_RISK_BAND',
      title: 'Transaction scored in the high-risk band by the risk provider',
      narrative:
        `Risk score ${row.score}/100 for ${formatPaise(Number(row.amount_paise))} ` +
        `by agent ${row.agent_id}. Factors: ${row.reasons.join('; ')}. ` +
        `NOTE: the risk provider is a labelled SIMULATION with invented ` +
        `heuristics and is advisory only - it did not affect the verdict.`,
      occurredAt: row.evaluated_at.toISOString(),
      mandateId: row.mandate_id, agentId: row.agent_id,
      decisionId: row.decision_id, amountPaise: Number(row.amount_paise),
      ruleCode: null, evidenceRefs: [row.decision_id],
    });
  }

  /* --- 6. Authentication failures ------------------------------------ */
  const authFailures = await client.query<{ actor_id: string | null; n: string; last_at: Date }>(
    `SELECT actor_id, count(*)::bigint AS n, max(occurred_at) AS last_at
       FROM audit_events
      WHERE event_type = 'AGENT_AUTH_REJECTED'
        AND occurred_at >= $1 AND occurred_at < $2
      GROUP BY actor_id
     HAVING count(*) >= 3
      ORDER BY count(*) DESC
      LIMIT 50`,
    [periodStart, periodEnd],
  );

  for (const row of authFailures.rows) {
    candidates.push({
      reason: 'AUTHENTICATION_FAILURES',
      title: 'Repeated rejected agent signatures',
      narrative:
        `${row.n} authentication attempts were rejected for ` +
        `${row.actor_id ?? 'an unidentified caller'} in this period. Rejected ` +
        `signatures may indicate credential misconfiguration, an expired key, ` +
        `or an attempt to impersonate a registered agent.`,
      occurredAt: row.last_at.toISOString(),
      mandateId: null, agentId: row.actor_id,
      decisionId: null, amountPaise: null, ruleCode: null, evidenceRefs: [],
    });
  }

  // Deterministic ordering: newest first, then by reason, then by decision id.
  // Without the tiebreakers, two runs over identical data could return the same
  // rows in a different order - and a report that is not byte-stable cannot be
  // hashed and compared.
  candidates.sort((a, b) =>
    b.occurredAt.localeCompare(a.occurredAt) ||
    a.reason.localeCompare(b.reason) ||
    (a.decisionId ?? '').localeCompare(b.decisionId ?? ''));

  return {
    kind: 'str_draft',
    status: 'DRAFT',
    generatedAt: now.toISOString(),
    periodStart: periodStart.toISOString(),
    periodEnd: periodEnd.toISOString(),
    candidateCount: candidates.length,
    candidates,
    reportingEntity: {
      name: 'ATL-India (demonstration implementation)',
      registrationStatus: 'NOT a registered reporting entity under the PMLA',
      finnetAccess: 'None. No FINnet integration exists.',
    },
    caveat: STR_CAVEAT,
    nextStep:
      'Review each candidate. Discard false positives. If any warrants a filing, ' +
      'a registered reporting entity must prepare and submit it through FINnet. ' +
      'This system cannot and will not file.',
  };
}
