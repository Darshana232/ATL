/**
 * Webhooks: verified, idempotent, and honest about what it cannot match.
 *
 * A webhook endpoint is the most exposed surface in a payment system - an
 * unauthenticated URL on the open internet that, if it is wrong, lets anyone
 * mark any payment captured.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHash, generateKeyPairSync, randomBytes } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { loadConfig, type Config } from '../config.js';
import { createLogger } from '../logger.js';
import { closePool, createPool, type Pool } from '../db/pool.js';
import { buildServer } from '../server.js';
import { withTransaction } from '../db/transaction.js';
import { insertMandate } from '../repositories/mandate.js';
import { createMandateTerms } from '../domain/mandate.js';
import { insertPayment, newPaymentId, markAuthorized } from '../repositories/payment.js';
import { signWebhook, RAZORPAY_SIGNATURE_HEADER, RAZORPAY_EVENT_ID_HEADER } from '../webhooks/signature.js';
import {
  hashBody, signRequest, KEY_HEADER, TIMESTAMP_HEADER,
  IDEMPOTENCY_HEADER, SIGNATURE_HEADER,
} from '../auth/signing.js';

const WEBHOOK_SECRET = 'whk_test_secret_value_for_the_suite';

const config: Config = loadConfig({
  ...process.env, NODE_ENV: 'test', LOG_LEVEL: 'fatal',
  // Forced on: without it the endpoint fails closed with 503 and every test
  // below would pass while proving nothing about verification.
  RAZORPAY_WEBHOOK_SECRET: WEBHOOK_SECRET,
});
const logger = createLogger(config);

const NOW = new Date('2026-09-07T08:52:00Z');
const suffix = randomBytes(4).toString('hex');
const AGENT = `agt_whk_${suffix}`;
const USER = `usr_whk_${suffix}`;
const MANDATE = `mnd_whk_${suffix}`;
const KEY_ID = `akid_whk_${suffix}`;

const { publicKey, privateKey } = generateKeyPairSync('ed25519');
const SPKI = publicKey.export({ type: 'spki', format: 'der' }).toString('base64');
const PRIV = privateKey.export({ type: 'pkcs8', format: 'der' }).toString('base64');

let pool: Pool;
let app: FastifyInstance;

beforeAll(async () => {
  pool = createPool(config, logger);
  app = buildServer({ config, logger, pool, now: () => NOW });
  await app.ready();

  await withTransaction(pool, async (tx) => {
    await tx.query(
      `INSERT INTO users (id, external_ref_hash, display_name) VALUES ($1,$2,'Webhook Test')`,
      [USER, createHash('sha256').update(USER).digest('hex')],
    );
    await tx.query(
      `INSERT INTO agents (id, display_name, vendor, agent_version)
       VALUES ($1,'Webhook Test Agent','test','1.0.0')`, [AGENT],
    );
    await tx.query(
      `INSERT INTO agent_credentials
         (id, agent_id, key_id, public_key_spki_b64, public_key_fingerprint)
       VALUES ($1,$2,$3,$4,$5)`,
      [`cred_whk_${suffix}`, AGENT, KEY_ID, SPKI,
       createHash('sha256').update(SPKI).digest('hex')],
    );
    await insertMandate(tx, {
      mandateId: MANDATE, userId: USER, agentId: AGENT, label: 'Webhook test',
      terms: createMandateTerms({
        perTxnLimitPaise: 500_000, windowLimitPaise: 5_000_000, windowKind: 'week',
        maxTxnPerHour: 50, timezone: 'Asia/Kolkata', windowStartHour: 0, windowEndHour: 24,
        allowedWeekdays: ['MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT', 'SUN'],
        validFrom: new Date('2026-09-01T00:00:00Z'),
        validTo: new Date('2026-12-31T23:59:59Z'),
        paymentMethods: ['upi_reserve_pay'],
      }),
      merchantIds: ['mer_bigbasket'], createdBy: 'test', changeReason: null,
      consentRef: 'consent_test', consentAt: new Date('2026-09-01T00:00:00Z'),
    });
  });
});

afterAll(async () => {
  await app.close();
  await closePool(pool, logger);
});

/**
 * A payment sitting in `authorized`, waiting for the provider to confirm.
 *
 * Created directly rather than through the API because the mock rail captures
 * immediately - the state a Razorpay webhook actually arrives for is one the
 * mock provider never produces.
 */
async function authorizedPayment(amountPaise: number, orderId: string): Promise<string> {
  // A FRESH authorization every time. An earlier version reused the most recent
  // decision for the mandate and hit `payments_decision_id_key` - which is the
  // constraint doing its job: one authorization moves money once. The test was
  // wrong, not the schema.
  const payload = JSON.stringify({
    mandateId: MANDATE, merchantId: 'mer_bigbasket',
    amountPaise, paymentMethod: 'upi_reserve_pay',
  });
  const parts = {
    method: 'POST', path: '/v1/authorize', timestamp: NOW.toISOString(),
    keyId: KEY_ID, idempotencyKey: `idem_${randomBytes(8).toString('hex')}`,
    bodySha256: hashBody(payload),
  };

  const response = await app.inject({
    method: 'POST', url: '/v1/authorize',
    headers: {
      'content-type': 'application/json',
      [KEY_HEADER]: KEY_ID, [TIMESTAMP_HEADER]: parts.timestamp,
      [IDEMPOTENCY_HEADER]: parts.idempotencyKey,
      [SIGNATURE_HEADER]: signRequest(PRIV, parts),
    },
    payload,
  });

  const decisionId = String((response.json() as Record<string, unknown>).decisionId);
  const paymentId = newPaymentId();

  // Inserted directly rather than through POST /v1/payments, because the mock
  // rail captures immediately - the `authorized` state a Razorpay webhook
  // actually arrives for is one the mock provider never produces.
  await withTransaction(pool, async (tx) => {
    await insertPayment(tx, {
      id: paymentId, decisionId, mandateId: MANDATE,
      voucherJti: randomBytes(16).toString('hex'), amountPaise,
      provider: 'razorpay_test',
    });
  });
  await markAuthorized(pool, paymentId, orderId, null);

  return paymentId;
}

function deliver(
  event: Record<string, unknown>,
  options: { secret?: string; eventId?: string; signature?: string } = {},
) {
  const rawBody = JSON.stringify(event);
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    [RAZORPAY_SIGNATURE_HEADER]:
      options.signature ?? signWebhook(options.secret ?? WEBHOOK_SECRET, rawBody),
  };
  if (options.eventId !== undefined) headers[RAZORPAY_EVENT_ID_HEADER] = options.eventId;

  return app.inject({ method: 'POST', url: '/v1/webhooks/razorpay', headers, payload: rawBody });
}

const capturedEvent = (orderId: string, amount: number, paymentId = `pay_rzp_${randomBytes(4).toString('hex')}`) => ({
  event: 'payment.captured',
  payload: { payment: { entity: { id: paymentId, order_id: orderId, amount, status: 'captured' } } },
});

/* ------------------------------------------------------------------------ */

describe('signature verification is the whole of the authentication', () => {
  it('accepts a correctly signed delivery', async () => {
    const orderId = `order_${randomBytes(6).toString('hex')}`;
    const paymentId = await authorizedPayment(45_000, orderId);

    const response = await deliver(capturedEvent(orderId, 45_000), {
      eventId: `evt_${randomBytes(6).toString('hex')}`,
    });

    expect(response.statusCode).toBe(200);
    expect((response.json() as Record<string, unknown>).outcome).toBe('captured');

    const row = await pool.query(`SELECT status FROM payments WHERE id = $1`, [paymentId]);
    expect(row.rows[0]?.status).toBe('captured');
  });

  it('REJECTS a forged delivery', async () => {
    // PREVENTS: anyone who finds this URL marking any payment captured.
    const orderId = `order_${randomBytes(6).toString('hex')}`;
    const paymentId = await authorizedPayment(46_000, orderId);

    const response = await deliver(capturedEvent(orderId, 46_000), {
      secret: 'the-attacker-does-not-know-the-secret',
      eventId: `evt_${randomBytes(6).toString('hex')}`,
    });

    expect(response.statusCode).toBe(401);

    const row = await pool.query(`SELECT status FROM payments WHERE id = $1`, [paymentId]);
    expect(row.rows[0]?.status).toBe('authorized'); // untouched
  });

  it('rejects a delivery with no signature at all', async () => {
    const rawBody = JSON.stringify(capturedEvent('order_x', 1000));
    const response = await app.inject({
      method: 'POST', url: '/v1/webhooks/razorpay',
      headers: { 'content-type': 'application/json' }, payload: rawBody,
    });

    expect(response.statusCode).toBe(401);
  });

  it('rejects a delivery whose BODY was altered after signing', async () => {
    // The signature covers the raw bytes, so changing the amount invalidates it
    // - the same property as the request signature in Phase 5.
    const orderId = `order_${randomBytes(6).toString('hex')}`;
    await authorizedPayment(47_000, orderId);

    const signed = JSON.stringify(capturedEvent(orderId, 47_000));
    const signature = signWebhook(WEBHOOK_SECRET, signed);
    const altered = JSON.stringify(capturedEvent(orderId, 9_999_900));

    const response = await app.inject({
      method: 'POST', url: '/v1/webhooks/razorpay',
      headers: {
        'content-type': 'application/json',
        [RAZORPAY_SIGNATURE_HEADER]: signature,
        [RAZORPAY_EVENT_ID_HEADER]: `evt_${randomBytes(6).toString('hex')}`,
      },
      payload: altered,
    });

    expect(response.statusCode).toBe(401);
  });

  it('RECORDS the forgery attempt as evidence', async () => {
    // Unlike a failed REQUEST signature (PHASE_05 section 12), this row has no
    // foreign keys to satisfy, so a forged attempt genuinely can be stored.
    const before = await pool.query(
      `SELECT count(*)::int AS n FROM webhook_events WHERE signature_verified = false`,
    );

    await deliver(capturedEvent('order_nope', 1000), {
      secret: 'wrong', eventId: `evt_${randomBytes(6).toString('hex')}`,
    });

    const after = await pool.query(
      `SELECT count(*)::int AS n FROM webhook_events WHERE signature_verified = false`,
    );
    expect(after.rows[0].n).toBe(before.rows[0].n + 1);
  });

  it('does not parse the body of an unverified delivery', async () => {
    // Authenticate first, interpret second. Malformed JSON with a bad signature
    // must produce 401, not a parser error.
    const response = await app.inject({
      method: 'POST', url: '/v1/webhooks/razorpay',
      headers: {
        'content-type': 'application/json',
        [RAZORPAY_SIGNATURE_HEADER]: 'deadbeef',
      },
      payload: '{ this is not json',
    });

    expect(response.statusCode).toBe(401);
  });
});

describe('delivery is at-least-once, so handling must be idempotent', () => {
  it('does not capture twice when the same event is redelivered', async () => {
    // THE BUG THIS PREVENTS: providers retry on any non-2xx and on timeouts,
    // including a timeout that happens AFTER we already succeeded.
    const orderId = `order_${randomBytes(6).toString('hex')}`;
    const paymentId = await authorizedPayment(48_000, orderId);
    const eventId = `evt_${randomBytes(6).toString('hex')}`;
    const event = capturedEvent(orderId, 48_000);

    const first = await deliver(event, { eventId });
    const second = await deliver(event, { eventId });

    expect(first.statusCode).toBe(200);
    expect(second.statusCode).toBe(200); // NOT an error - retrying is correct
    expect((second.json() as Record<string, unknown>).duplicate).toBe(true);

    const rows = await pool.query(
      `SELECT count(*)::int AS n FROM webhook_events WHERE provider_event_id = $1`, [eventId],
    );
    expect(rows.rows[0].n).toBe(1);

    const captures = await pool.query(
      `SELECT count(*)::int AS n FROM audit_events
        WHERE subject_id = $1 AND event_type = 'PAYMENT_CAPTURED'`, [paymentId],
    );
    expect(captures.rows[0].n).toBe(1);
  });

  it('survives CONCURRENT redelivery of the same event', async () => {
    const orderId = `order_${randomBytes(6).toString('hex')}`;
    await authorizedPayment(49_000, orderId);
    const eventId = `evt_${randomBytes(6).toString('hex')}`;
    const event = capturedEvent(orderId, 49_000);

    const results = await Promise.all([
      deliver(event, { eventId }), deliver(event, { eventId }), deliver(event, { eventId }),
    ]);

    for (const result of results) expect(result.statusCode).toBe(200);

    const rows = await pool.query(
      `SELECT count(*)::int AS n FROM webhook_events WHERE provider_event_id = $1`, [eventId],
    );
    expect(rows.rows[0].n).toBe(1);
  });

  it('falls back to a body hash when the provider sends no event id', async () => {
    // Weaker, and recorded as such: two genuinely distinct events with
    // identical bodies would be indistinguishable from one redelivery.
    const orderId = `order_${randomBytes(6).toString('hex')}`;
    await authorizedPayment(50_000, orderId);

    const response = await deliver(capturedEvent(orderId, 50_000));
    expect(response.statusCode).toBe(200);

    const row = await pool.query<{ event_id_source: string }>(
      `SELECT event_id_source FROM webhook_events ORDER BY received_at DESC LIMIT 1`,
    );
    expect(row.rows[0]?.event_id_source).toBe('body_hash');
  });
});

describe('the handler is honest about what it cannot reconcile', () => {
  it('records an AMOUNT MISMATCH as failed rather than capturing it', async () => {
    // The provider telling us a different amount was captured is a
    // reconciliation incident, not a routine capture.
    const orderId = `order_${randomBytes(6).toString('hex')}`;
    const paymentId = await authorizedPayment(51_000, orderId);

    const response = await deliver(capturedEvent(orderId, 99_999_00), {
      eventId: `evt_${randomBytes(6).toString('hex')}`,
    });

    expect(response.statusCode).toBe(200);
    expect((response.json() as Record<string, unknown>).outcome).toBe('failed');

    const row = await pool.query(`SELECT status FROM payments WHERE id = $1`, [paymentId]);
    expect(row.rows[0]?.status).toBe('authorized'); // NOT captured
  });

  it('records an unmatched event without inventing a payment', async () => {
    const response = await deliver(capturedEvent('order_we_have_never_seen', 1_000), {
      eventId: `evt_${randomBytes(6).toString('hex')}`,
    });

    expect(response.statusCode).toBe(200);
    expect((response.json() as Record<string, unknown>).outcome).toBe('unmatched');
  });

  it('acknowledges an event type it does not handle, rather than failing it', async () => {
    // Returning 500 for an event we simply do not handle would make the
    // provider retry it forever.
    const response = await deliver(
      { event: 'subscription.charged', payload: {} },
      { eventId: `evt_${randomBytes(6).toString('hex')}` },
    );

    expect(response.statusCode).toBe(200);
    expect((response.json() as Record<string, unknown>).outcome).toBe('ignored');
  });

  it('marks a payment failed when the provider says it failed', async () => {
    const orderId = `order_${randomBytes(6).toString('hex')}`;
    const paymentId = await authorizedPayment(52_000, orderId);

    const response = await deliver({
      event: 'payment.failed',
      payload: {
        payment: {
          entity: {
            id: `pay_rzp_${randomBytes(4).toString('hex')}`, order_id: orderId,
            amount: 52_000, status: 'failed',
            error_code: 'BAD_REQUEST_ERROR',
            error_description: 'Payment failed at the bank.',
          },
        },
      },
    }, { eventId: `evt_${randomBytes(6).toString('hex')}` });

    expect(response.statusCode).toBe(200);

    const row = await pool.query<{ status: string; failure_code: string }>(
      `SELECT status, failure_code FROM payments WHERE id = $1`, [paymentId],
    );
    expect(row.rows[0]?.status).toBe('failed');
    expect(row.rows[0]?.failure_code).toBe('BAD_REQUEST_ERROR');
  });
});

describe('fail closed when verification is not configured', () => {
  it('refuses every webhook when no secret is set', async () => {
    // Accepting unverified webhooks "for now" would mean anyone who finds the
    // URL can mark payments captured.
    const unconfigured = buildServer({
      config: { ...config, RAZORPAY_WEBHOOK_SECRET: undefined } as Config,
      logger, pool, now: () => NOW,
    });
    await unconfigured.ready();

    try {
      const rawBody = JSON.stringify(capturedEvent('order_x', 1000));
      const response = await unconfigured.inject({
        method: 'POST', url: '/v1/webhooks/razorpay',
        headers: {
          'content-type': 'application/json',
          [RAZORPAY_SIGNATURE_HEADER]: signWebhook(WEBHOOK_SECRET, rawBody),
        },
        payload: rawBody,
      });

      expect(response.statusCode).toBe(503);
    } finally {
      await unconfigured.close();
    }
  });
});
