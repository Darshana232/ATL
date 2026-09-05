/**
 * Payment persistence.
 *
 * The single most important line in this file is the INSERT: `voucher_jti` is
 * UNIQUE and `decision_id` is UNIQUE, so "a voucher can be spent once" and "an
 * authorization moves money once" are DATABASE FACTS rather than application
 * promises.
 *
 * The alternative - SELECT to check whether we have seen this jti, then INSERT
 * - is check-then-write, and it loses the race a unique index wins. Two
 * perfectly concurrent redemptions both pass the SELECT.
 */
import { randomBytes } from 'node:crypto';
import type pg from 'pg';

export const newPaymentId = (): string => `pay_${randomBytes(10).toString('hex')}`;

export const UNIQUE_VIOLATION = '23505';

export interface PaymentRow {
  readonly id: string;
  readonly decisionId: string;
  readonly mandateId: string;
  readonly voucherJti: string;
  readonly amountPaise: number;
  readonly provider: string;
  readonly providerOrderId: string | null;
  readonly providerPaymentId: string | null;
  readonly status: string;
  readonly failureCode: string | null;
  readonly failureReason: string | null;
  readonly createdAt: Date;
  readonly capturedAt: Date | null;
}

interface RawPaymentRow {
  id: string; decision_id: string; mandate_id: string; voucher_jti: string;
  amount_paise: string | number; provider: string; provider_order_id: string | null;
  provider_payment_id: string | null; status: string; failure_code: string | null;
  failure_reason: string | null; created_at: Date; captured_at: Date | null;
}

function toPayment(row: RawPaymentRow): PaymentRow {
  return {
    id: row.id,
    decisionId: row.decision_id,
    mandateId: row.mandate_id,
    voucherJti: row.voucher_jti,
    amountPaise: Number(row.amount_paise),
    provider: row.provider,
    providerOrderId: row.provider_order_id,
    providerPaymentId: row.provider_payment_id,
    status: row.status,
    failureCode: row.failure_code,
    failureReason: row.failure_reason,
    createdAt: row.created_at,
    capturedAt: row.captured_at,
  };
}

const COLUMNS = `
  id, decision_id, mandate_id, voucher_jti, amount_paise, provider,
  provider_order_id, provider_payment_id, status, failure_code, failure_reason,
  created_at, captured_at
`;

/**
 * Claim the voucher.
 *
 * This INSERT *is* the redemption. It succeeds at most once per voucher and at
 * most once per decision, whatever happens concurrently, because the database
 * says so. Everything after it - talking to the provider, capturing - happens
 * only for the caller that won.
 */
export async function insertPayment(
  txClient: pg.PoolClient,
  params: {
    readonly id: string;
    readonly decisionId: string;
    readonly mandateId: string;
    readonly voucherJti: string;
    readonly amountPaise: number;
    readonly provider: string;
  },
): Promise<void> {
  await txClient.query(
    `INSERT INTO payments (id, decision_id, mandate_id, voucher_jti, amount_paise, provider)
     VALUES ($1,$2,$3,$4,$5,$6)`,
    [params.id, params.decisionId, params.mandateId, params.voucherJti,
     params.amountPaise, params.provider],
  );
}

/**
 * Move a payment along its lifecycle.
 *
 * The legal transitions are enforced by `payments_guard_transition` in
 * migration 0004, not here. That is deliberate: a payment going
 * captured -> created is not merely a bug, it is a record that LIES about
 * whether money moved, and the application should prevent it while the database
 * must.
 */
export async function markAuthorized(
  client: pg.PoolClient | pg.Pool,
  id: string,
  providerOrderId: string | null,
  providerPaymentId: string | null,
): Promise<void> {
  await client.query(
    `UPDATE payments
        SET status = 'authorized', authorized_at = now(),
            provider_order_id = COALESCE($2, provider_order_id),
            provider_payment_id = COALESCE($3, provider_payment_id)
      WHERE id = $1`,
    [id, providerOrderId, providerPaymentId],
  );
}

export async function markCaptured(
  client: pg.PoolClient | pg.Pool,
  id: string,
  providerPaymentId: string | null,
): Promise<void> {
  await client.query(
    `UPDATE payments
        SET status = 'captured', captured_at = now(),
            provider_payment_id = COALESCE($2, provider_payment_id)
      WHERE id = $1`,
    [id, providerPaymentId],
  );
}

export async function markFailed(
  client: pg.PoolClient | pg.Pool,
  id: string,
  code: string,
  reason: string,
): Promise<void> {
  await client.query(
    `UPDATE payments
        SET status = 'failed', failed_at = now(), failure_code = $2, failure_reason = $3
      WHERE id = $1`,
    // Bounded: these strings come from an external provider and are stored and
    // later rendered. An unbounded provider message is somebody else's text in
    // our database.
    [id, code.slice(0, 100), reason.slice(0, 500)],
  );
}

export async function findPaymentById(
  client: pg.PoolClient | pg.Pool,
  id: string,
): Promise<PaymentRow | null> {
  const result = await client.query<RawPaymentRow>(
    `SELECT ${COLUMNS} FROM payments WHERE id = $1`, [id],
  );
  const row = result.rows[0];
  return row === undefined ? null : toPayment(row);
}

export async function findPaymentByVoucherJti(
  client: pg.PoolClient | pg.Pool,
  jti: string,
): Promise<PaymentRow | null> {
  const result = await client.query<RawPaymentRow>(
    `SELECT ${COLUMNS} FROM payments WHERE voucher_jti = $1`, [jti],
  );
  const row = result.rows[0];
  return row === undefined ? null : toPayment(row);
}

/** Webhooks arrive with the PROVIDER's id, not ours. */
export async function findPaymentByProviderId(
  client: pg.PoolClient | pg.Pool,
  provider: string,
  providerPaymentId: string,
): Promise<PaymentRow | null> {
  const result = await client.query<RawPaymentRow>(
    `SELECT ${COLUMNS} FROM payments
      WHERE provider = $1 AND provider_payment_id = $2`,
    [provider, providerPaymentId],
  );
  const row = result.rows[0];
  return row === undefined ? null : toPayment(row);
}

export async function findPaymentByProviderOrderId(
  client: pg.PoolClient | pg.Pool,
  provider: string,
  providerOrderId: string,
): Promise<PaymentRow | null> {
  const result = await client.query<RawPaymentRow>(
    `SELECT ${COLUMNS} FROM payments
      WHERE provider = $1 AND provider_order_id = $2
      ORDER BY created_at DESC LIMIT 1`,
    [provider, providerOrderId],
  );
  const row = result.rows[0];
  return row === undefined ? null : toPayment(row);
}

/** The decision a voucher refers to, for cross-checking its claims. */
export interface DecisionForPayment {
  readonly decisionId: string;
  readonly mandateId: string;
  readonly mandateVersion: number;
  readonly verdict: string;
  readonly agentId: string;
  readonly merchantId: string;
  readonly amountPaise: number;
}

export async function loadDecisionForPayment(
  client: pg.PoolClient | pg.Pool,
  decisionId: string,
): Promise<DecisionForPayment | null> {
  const result = await client.query<{
    id: string; mandate_id: string; mandate_version: number; verdict: string;
    agent_id: string; merchant_id: string; amount_paise: string | number;
  }>(
    `SELECT d.id, d.mandate_id, d.mandate_version, d.verdict,
            r.agent_id, r.merchant_id, r.amount_paise
       FROM decisions d
       JOIN authorization_requests r ON r.id = d.authorization_request_id
      WHERE d.id = $1`,
    [decisionId],
  );

  const row = result.rows[0];
  if (row === undefined) return null;

  return {
    decisionId: row.id,
    mandateId: row.mandate_id,
    mandateVersion: row.mandate_version,
    verdict: row.verdict,
    agentId: row.agent_id,
    merchantId: row.merchant_id,
    amountPaise: Number(row.amount_paise),
  };
}
