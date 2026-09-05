/**
 * Webhook delivery persistence.
 *
 * One function, and the INSERT is the whole point: `UNIQUE (provider,
 * provider_event_id)` is what makes at-least-once delivery safe. A redelivered
 * event loses here rather than capturing a payment a second time.
 */
import { randomBytes } from 'node:crypto';
import type pg from 'pg';

export const newWebhookEventId = (): string => `whk_${randomBytes(10).toString('hex')}`;

export type WebhookOutcome =
  | 'captured' | 'failed' | 'ignored' | 'rejected' | 'unmatched' | 'duplicate';

export interface RecordDeliveryParams {
  readonly provider: string;
  readonly providerEventId: string;
  readonly eventIdSource: 'header' | 'body_hash';
  readonly eventType: string;
  readonly signatureVerified: boolean;
  readonly outcome: WebhookOutcome;
  readonly outcomeDetail: string | null;
  readonly paymentId: string | null;
  readonly payload: unknown;
  readonly rawBodySha256: string;
}

export async function insertWebhookEvent(
  txClient: pg.PoolClient,
  params: RecordDeliveryParams,
): Promise<string> {
  const id = newWebhookEventId();

  await txClient.query(
    `INSERT INTO webhook_events
       (id, provider, provider_event_id, event_id_source, event_type,
        signature_verified, outcome, outcome_detail, payment_id, payload,
        raw_body_sha256)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
    [
      id, params.provider, params.providerEventId, params.eventIdSource,
      params.eventType, params.signatureVerified, params.outcome,
      params.outcomeDetail?.slice(0, 500) ?? null, params.paymentId,
      JSON.stringify(params.payload ?? {}), params.rawBodySha256,
    ],
  );

  return id;
}

export async function findDelivery(
  client: pg.PoolClient | pg.Pool,
  provider: string,
  providerEventId: string,
): Promise<{ id: string; outcome: string; paymentId: string | null } | null> {
  const result = await client.query<{ id: string; outcome: string; payment_id: string | null }>(
    `SELECT id, outcome, payment_id FROM webhook_events
      WHERE provider = $1 AND provider_event_id = $2`,
    [provider, providerEventId],
  );

  const row = result.rows[0];
  return row === null || row === undefined
    ? null
    : { id: row.id, outcome: row.outcome, paymentId: row.payment_id };
}
