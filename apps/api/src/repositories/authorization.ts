/**
 * Persistence for the authorization path.
 *
 * Every function takes a transaction client, never a pool. The request, the
 * decision, the thirteen rule evaluations, the risk signal and the audit event
 * must land together or not at all: a decision with no request, or a verdict
 * with no rule breakdown, is worse than no record.
 */
import { randomBytes } from 'node:crypto';
import type pg from 'pg';
import type { Decision, RiskInput, SpendSnapshot } from '../policy/types.js';

export const newAuthorizationRequestId = (): string =>
  `authz_${randomBytes(10).toString('hex')}`;
export const newDecisionId = (): string => `dec_${randomBytes(10).toString('hex')}`;
export const newRiskSignalId = (): string => `rsk_${randomBytes(10).toString('hex')}`;

export interface InsertRequestParams {
  readonly id: string;
  readonly mandateId: string;
  readonly mandateVersion: number;
  readonly agentId: string;
  readonly credentialId: string;
  readonly signatureVerified: boolean;
  readonly merchantId: string;
  readonly amountPaise: number;
  readonly paymentMethod: string;
  readonly idempotencyKey: string;
  readonly requestId: string;
  readonly cart: unknown;
  readonly userIntent: string | null;
}

export async function insertAuthorizationRequest(
  txClient: pg.PoolClient,
  params: InsertRequestParams,
): Promise<void> {
  await txClient.query(
    `INSERT INTO authorization_requests
       (id, mandate_id, mandate_version, agent_id, credential_id, signature_verified,
        merchant_id, amount_paise, payment_method, idempotency_key, request_id,
        cart, user_intent)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
    [
      params.id, params.mandateId, params.mandateVersion, params.agentId,
      params.credentialId, params.signatureVerified, params.merchantId,
      params.amountPaise, params.paymentMethod, params.idempotencyKey,
      params.requestId,
      params.cart === undefined ? null : JSON.stringify(params.cart),
      params.userIntent,
    ],
  );
}

export interface InsertDecisionParams {
  readonly id: string;
  readonly authorizationRequestId: string;
  readonly mandateId: string;
  readonly mandateVersion: number;
  readonly decision: Decision;
  readonly spend: SpendSnapshot;
  readonly risk: RiskInput | null;
  readonly durationUs: number;
}

/**
 * Write the decision and its per-rule breakdown.
 *
 * The rule rows go in as ONE multi-row INSERT rather than thirteen statements.
 * Thirteen round trips on the hottest path in the system is the kind of cost
 * that is invisible locally and obvious in production.
 */
export async function insertDecision(
  txClient: pg.PoolClient,
  params: InsertDecisionParams,
): Promise<void> {
  const { decision, spend, risk } = params;

  await txClient.query(
    `INSERT INTO decisions
       (id, authorization_request_id, mandate_id, mandate_version, verdict, reason,
        engine_version, spend_window_start, spend_window_end, spent_before_paise,
        risk_score, risk_provider, evaluated_at, evaluation_duration_us)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
    [
      params.id, params.authorizationRequestId, params.mandateId, params.mandateVersion,
      decision.verdict, decision.reason, decision.engineVersion,
      spend.windowStart, spend.windowEnd, spend.spentInWindowPaise,
      risk?.score ?? null, risk?.provider ?? null,
      decision.evaluatedAt, params.durationUs,
    ],
  );

  // ONE multi-row INSERT for all thirteen rule rows. Thirteen separate
  // statements would be thirteen round trips on the hottest path in the system
  // - invisible on localhost, obvious in production.
  //
  // Placeholders are GENERATED, and the parameters stay parameters. Building
  // this by interpolating values into SQL is how SQL injection happens; the
  // shape of the statement is ours, every value is bound.
  const COLUMNS_PER_ROW = 10;
  const values: unknown[] = [];
  const rows = decision.evaluations.map((item, index) => {
    const base = index * COLUMNS_PER_ROW;

    values.push(
      params.id, item.ruleCode, item.sequence, item.verdict,
      item.signal, item.expected, item.actual, item.reason,
      item.observedPaise, item.limitPaise,
    );

    const placeholders = Array.from(
      { length: COLUMNS_PER_ROW },
      (_unused, offset) => `$${base + offset + 1}`,
    );

    return `(${placeholders.join(',')})`;
  });

  await txClient.query(
    `INSERT INTO rule_evaluations
       (decision_id, rule_code, sequence, verdict, signal, expected, actual, reason,
        observed_paise, limit_paise)
     VALUES ${rows.join(',')}`,
    values,
  );
}

export async function insertRiskSignal(
  txClient: pg.PoolClient,
  params: {
    readonly id: string;
    readonly authorizationRequestId: string;
    readonly risk: RiskInput;
    readonly latencyMs: number;
  },
): Promise<void> {
  await txClient.query(
    `INSERT INTO risk_signals
       (id, authorization_request_id, provider, score, band, reasons, latency_ms)
     VALUES ($1,$2,$3,$4,$5,$6,$7)`,
    [
      params.id, params.authorizationRequestId, params.risk.provider,
      params.risk.score, params.risk.band, [...params.risk.reasons], params.latencyMs,
    ],
  );
}

export interface StoredDecision {
  readonly decisionId: string;
  readonly authorizationRequestId: string;
  readonly mandateId: string;
  readonly mandateVersion: number;
  readonly agentId: string;
  readonly merchantId: string;
  readonly amountPaise: number;
  readonly verdict: 'PASS' | 'FLAG' | 'BLOCK';
  readonly reason: string;
  readonly engineVersion: string;
  readonly evaluatedAt: Date;
  readonly riskScore: number | null;
  readonly riskProvider: string | null;
  readonly evaluations: readonly {
    readonly ruleCode: string;
    readonly sequence: number;
    readonly verdict: string;
    readonly signal: string;
    readonly expected: string;
    readonly actual: string;
    readonly reason: string;
    readonly observedPaise: number | null;
    readonly limitPaise: number | null;
  }[];
}

/**
 * The idempotent-replay read: find the decision a previous request already
 * produced for this (agent, idempotency key).
 *
 * ONE QUERY, using a LATERAL aggregate over the rule rows. The alternative -
 * fetch the decision, then fetch its rules - is a second round trip on a path
 * that runs on every retry.
 *
 * Ordering the aggregate by `sequence` matters: the breakdown must replay in
 * the order the rules actually ran.
 */
export async function findDecisionByIdempotencyKey(
  client: pg.PoolClient | pg.Pool,
  agentId: string,
  idempotencyKey: string,
): Promise<StoredDecision | null> {
  const result = await client.query<{
    decision_id: string; authorization_request_id: string; mandate_id: string;
    mandate_version: number; agent_id: string; merchant_id: string;
    amount_paise: number; verdict: string; reason: string; engine_version: string;
    evaluated_at: Date; risk_score: number | null; risk_provider: string | null;
    evaluations: StoredDecision['evaluations'] | null;
  }>(
    `SELECT d.id AS decision_id, r.id AS authorization_request_id,
            d.mandate_id, d.mandate_version, r.agent_id, r.merchant_id,
            r.amount_paise, d.verdict, d.reason, d.engine_version, d.evaluated_at,
            d.risk_score, d.risk_provider, ev.evaluations
       FROM authorization_requests r
       JOIN decisions d ON d.authorization_request_id = r.id
       LEFT JOIN LATERAL (
         SELECT json_agg(
                  json_build_object(
                    'ruleCode', re.rule_code, 'sequence', re.sequence,
                    'verdict', re.verdict, 'signal', re.signal,
                    'expected', re.expected, 'actual', re.actual,
                    'reason', re.reason,
                    'observedPaise', re.observed_paise, 'limitPaise', re.limit_paise
                  ) ORDER BY re.sequence
                ) AS evaluations
           FROM rule_evaluations re
          WHERE re.decision_id = d.id
       ) ev ON true
      WHERE r.agent_id = $1 AND r.idempotency_key = $2`,
    [agentId, idempotencyKey],
  );

  const row = result.rows[0];
  if (row === undefined) return null;

  return {
    decisionId: row.decision_id,
    authorizationRequestId: row.authorization_request_id,
    mandateId: row.mandate_id,
    mandateVersion: row.mandate_version,
    agentId: row.agent_id,
    merchantId: row.merchant_id,
    amountPaise: Number(row.amount_paise),
    verdict: row.verdict as StoredDecision['verdict'],
    reason: row.reason,
    engineVersion: row.engine_version,
    evaluatedAt: row.evaluated_at,
    riskScore: row.risk_score === null ? null : Number(row.risk_score),
    riskProvider: row.risk_provider,
    evaluations: row.evaluations ?? [],
  };
}

/** The merchant's category code, needed by the CATEGORY_BLOCKLIST rule. */
export async function loadMerchantMcc(
  client: pg.PoolClient | pg.Pool,
  merchantId: string,
): Promise<{ mcc: string; status: string } | null> {
  const result = await client.query<{ mcc: string; status: string }>(
    `SELECT mcc, status FROM merchants WHERE id = $1`,
    [merchantId],
  );

  const row = result.rows[0];
  return row === undefined ? null : { mcc: row.mcc, status: row.status };
}
