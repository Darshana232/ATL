/**
 * Payments end to end: authorize, then redeem, over real HTTP with real
 * signatures and a real database.
 *
 * THE CENTRAL CLAIM OF THE WHOLE PROJECT is tested here: there is no path to a
 * payment provider that does not go through a voucher minted by the
 * deterministic policy engine.
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
import { MockUpiProvider } from '../providers/payment.js';
import { mintVoucher } from '../voucher/voucher.js';
import {
  hashBody, signRequest, KEY_HEADER, TIMESTAMP_HEADER,
  IDEMPOTENCY_HEADER, SIGNATURE_HEADER,
} from '../auth/signing.js';

const config: Config = loadConfig({ ...process.env, NODE_ENV: 'test', LOG_LEVEL: 'fatal' });
const logger = createLogger(config);

const NOW = new Date('2026-09-07T08:52:00Z'); // Monday 14:22 IST

const suffix = randomBytes(4).toString('hex');
const AGENT = `agt_pay_${suffix}`;
const OTHER_AGENT = `agt_payb_${suffix}`;
const USER = `usr_pay_${suffix}`;
const MANDATE = `mnd_pay_${suffix}`;
const KEY_ID = `akid_pay_${suffix}`;
const OTHER_KEY_ID = `akid_payb_${suffix}`;

function keypair() {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const spki = publicKey.export({ type: 'spki', format: 'der' }).toString('base64');
  return {
    spki, fingerprint: createHash('sha256').update(spki).digest('hex'),
    priv: privateKey.export({ type: 'pkcs8', format: 'der' }).toString('base64'),
  };
}

const main = keypair();
const other = keypair();

let pool: Pool;
let app: FastifyInstance;

beforeAll(async () => {
  pool = createPool(config, logger);
  app = buildServer({
    config, logger, pool, now: () => NOW,
    // Zero delay: the simulated latency is for demos, not for the test suite.
    payments: new MockUpiProvider(0),
  });
  await app.ready();

  await withTransaction(pool, async (tx) => {
    await tx.query(
      `INSERT INTO users (id, external_ref_hash, display_name) VALUES ($1,$2,'Pay Test')`,
      [USER, createHash('sha256').update(USER).digest('hex')],
    );

    for (const id of [AGENT, OTHER_AGENT]) {
      await tx.query(
        `INSERT INTO agents (id, display_name, vendor, agent_version)
         VALUES ($1,'Pay Test Agent','test','1.0.0')`, [id],
      );
    }

    for (const [credId, agentId, key, keyId] of [
      [`cred_pa_${suffix}`, AGENT, main, KEY_ID],
      [`cred_pb_${suffix}`, OTHER_AGENT, other, OTHER_KEY_ID],
    ] as const) {
      await tx.query(
        `INSERT INTO agent_credentials
           (id, agent_id, key_id, public_key_spki_b64, public_key_fingerprint)
         VALUES ($1,$2,$3,$4,$5)`,
        [credId, agentId, keyId, key.spki, key.fingerprint],
      );
    }

    await insertMandate(tx, {
      mandateId: MANDATE, userId: USER, agentId: AGENT, label: 'Payment test mandate',
      terms: createMandateTerms({
        perTxnLimitPaise: 200_000, windowLimitPaise: 5_000_000, windowKind: 'week',
        maxTxnPerHour: 50, blockedMccs: ['5921'], timezone: 'Asia/Kolkata',
        windowStartHour: 8, windowEndHour: 20,
        allowedWeekdays: ['MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT'],
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

/* ------------------------------------------------------------------------ */
/* Signed-call helper                                                       */
/* ------------------------------------------------------------------------ */

async function signedCall(
  path: string,
  body: Record<string, unknown>,
  options: { privateKey?: string; keyId?: string } = {},
) {
  const payload = JSON.stringify(body);
  const parts = {
    method: 'POST', path, timestamp: NOW.toISOString(),
    keyId: options.keyId ?? KEY_ID,
    idempotencyKey: `idem_${randomBytes(8).toString('hex')}`,
    bodySha256: hashBody(payload),
  };

  const response = await app.inject({
    method: 'POST', url: path,
    headers: {
      'content-type': 'application/json',
      [KEY_HEADER]: parts.keyId,
      [TIMESTAMP_HEADER]: parts.timestamp,
      [IDEMPOTENCY_HEADER]: parts.idempotencyKey,
      [SIGNATURE_HEADER]: signRequest(options.privateKey ?? main.priv, parts),
    },
    payload,
  });

  return { response, body: response.json() as Record<string, unknown> };
}

/** Authorize once and return the voucher token, or null on BLOCK. */
async function authorize(
  amountPaise = 124_000,
  merchantId = 'mer_bigbasket',
): Promise<{ token: string | null; decisionId: string; verdict: string }> {
  const { body } = await signedCall('/v1/authorize', {
    mandateId: MANDATE, merchantId, amountPaise, paymentMethod: 'upi_reserve_pay',
  });

  const voucher = body.voucher as { token: string } | null;
  return {
    token: voucher?.token ?? null,
    decisionId: String(body.decisionId),
    verdict: String(body.verdict),
  };
}

/* ------------------------------------------------------------------------ */

describe('the happy path: authorize, then pay', () => {
  it('captures a payment when a valid voucher is presented', async () => {
    const { token } = await authorize(124_000);
    expect(token).not.toBeNull();

    const { response, body } = await signedCall('/v1/payments', {
      voucher: token, amountPaise: 124_000, merchantId: 'mer_bigbasket',
    });

    expect(response.statusCode).toBe(201);
    expect(body.status).toBe('captured');
    expect(body.amountPaise).toBe(124_000);
  });

  it('labels the payment as SIMULATED in the response and in the database', async () => {
    // A report must be physically unable to present a simulated settlement as
    // a real one.
    const { token } = await authorize(101_000);
    const { body } = await signedCall('/v1/payments', {
      voucher: token, amountPaise: 101_000, merchantId: 'mer_bigbasket',
    });

    expect(body.simulated).toBe(true);
    expect(body.provider).toBe('mock_upi');

    const row = await pool.query(`SELECT provider FROM payments WHERE id = $1`, [body.paymentId]);
    expect(row.rows[0].provider).toBe('mock_upi');
  });

  it('writes PAYMENT_INITIATED and PAYMENT_CAPTURED into the hash chain', async () => {
    const { token } = await authorize(102_000);
    const { body } = await signedCall('/v1/payments', {
      voucher: token, amountPaise: 102_000, merchantId: 'mer_bigbasket',
    });

    const events = await pool.query<{ event_type: string }>(
      `SELECT event_type FROM audit_events WHERE subject_id = $1 ORDER BY seq`,
      [body.paymentId],
    );

    const types = events.rows.map((r) => r.event_type);
    expect(types).toContain('PAYMENT_INITIATED');
    expect(types).toContain('PAYMENT_CAPTURED');
  });

  it('links the payment to the decision that authorised it', async () => {
    const { token, decisionId } = await authorize(103_000);
    const { body } = await signedCall('/v1/payments', {
      voucher: token, amountPaise: 103_000, merchantId: 'mer_bigbasket',
    });

    expect(body.decisionId).toBe(decisionId);
  });

  it('exposes the payment for reconciliation', async () => {
    const { token } = await authorize(104_000);
    const { body } = await signedCall('/v1/payments', {
      voucher: token, amountPaise: 104_000, merchantId: 'mer_bigbasket',
    });

    // A GET has NO BODY, so the body hash is the hash of the empty string.
    // The signed `path` is the ROUTE PATTERN (`/v1/payments/:id`), not the
    // concrete URL - the server signs what it routed to, so a signature cannot
    // be replayed against a different payment id... which also means the id
    // itself is not covered, and that is recorded as debt in PHASE_07 section 12.
    const parts = {
      method: 'GET', path: '/v1/payments/:id', timestamp: NOW.toISOString(),
      keyId: KEY_ID, idempotencyKey: `idem_${randomBytes(8).toString('hex')}`,
      bodySha256: hashBody(''),
    };

    const response = await app.inject({
      method: 'GET', url: `/v1/payments/${String(body.paymentId)}`,
      headers: {
        [KEY_HEADER]: KEY_ID, [TIMESTAMP_HEADER]: parts.timestamp,
        [IDEMPOTENCY_HEADER]: parts.idempotencyKey,
        [SIGNATURE_HEADER]: signRequest(main.priv, parts),
      },
    });

    expect(response.statusCode).toBe(200);
    expect((response.json() as Record<string, unknown>).status).toBe('captured');
  });
});

describe('NO VOUCHER, NO PAYMENT - the central claim', () => {
  it('refuses a payment with no voucher at all', async () => {
    const { response } = await signedCall('/v1/payments', {
      amountPaise: 124_000, merchantId: 'mer_bigbasket',
    });

    expect(response.statusCode).toBe(400); // the field is required
  });

  it('refuses a made-up voucher string', async () => {
    const { response, body } = await signedCall('/v1/payments', {
      voucher: 'atlv1.bm90LWEtcmVhbC12b3VjaGVy.ZmFrZQ',
      amountPaise: 124_000, merchantId: 'mer_bigbasket',
    });

    expect(response.statusCode).toBe(401);
    expect(body.error).toBe('invalid_voucher');
  });

  it('refuses a voucher whose MAC has been altered by one character', async () => {
    const { token } = await authorize(105_000);
    const [prefix, payload, mac] = token!.split('.') as [string, string, string];
    const flipped = mac[0] === 'A' ? `B${mac.slice(1)}` : `A${mac.slice(1)}`;

    const { response } = await signedCall('/v1/payments', {
      voucher: `${prefix}.${payload}.${flipped}`,
      amountPaise: 105_000, merchantId: 'mer_bigbasket',
    });

    expect(response.statusCode).toBe(401);
  });

  it('refuses a voucher signed with a different secret', async () => {
    // PREVENTS: an attacker who can mint their own tokens.
    const forged = mintVoucher('f'.repeat(64), {
      decisionId: 'dec_whatever', mandateId: MANDATE, agentId: AGENT,
      merchantId: 'mer_bigbasket', amountPaise: 124_000, verdict: 'PASS', now: NOW,
    });

    const { response } = await signedCall('/v1/payments', {
      voucher: forged.token, amountPaise: 124_000, merchantId: 'mer_bigbasket',
    });

    expect(response.statusCode).toBe(401);
  });

  it('refuses an EXPIRED voucher', async () => {
    const { token } = await authorize(106_000);

    // A second server whose clock is two minutes ahead - the voucher's 60s TTL
    // has passed.
    const later = buildServer({
      config, logger, pool, payments: new MockUpiProvider(0),
      now: () => new Date(NOW.getTime() + 120_000),
    });
    await later.ready();

    try {
      const payload = JSON.stringify({
        voucher: token, amountPaise: 106_000, merchantId: 'mer_bigbasket',
      });
      const timestamp = new Date(NOW.getTime() + 120_000).toISOString();
      const parts = {
        method: 'POST', path: '/v1/payments', timestamp, keyId: KEY_ID,
        idempotencyKey: `idem_${randomBytes(8).toString('hex')}`,
        bodySha256: hashBody(payload),
      };

      const response = await later.inject({
        method: 'POST', url: '/v1/payments',
        headers: {
          'content-type': 'application/json',
          [KEY_HEADER]: KEY_ID, [TIMESTAMP_HEADER]: timestamp,
          [IDEMPOTENCY_HEADER]: parts.idempotencyKey,
          [SIGNATURE_HEADER]: signRequest(main.priv, parts),
        },
        payload,
      });

      expect(response.statusCode).toBe(401);
    } finally {
      await later.close();
    }
  });

  it('a BLOCKED authorization produces no voucher and therefore no payment', async () => {
    // The end-to-end version of the central claim.
    const { token, verdict } = await authorize(620_000); // over the 2,000 limit

    expect(verdict).toBe('BLOCK');
    expect(token).toBeNull();

    const before = await pool.query(
      `SELECT count(*)::int AS n FROM payments WHERE mandate_id = $1`, [MANDATE],
    );

    const { response } = await signedCall('/v1/payments', {
      voucher: 'atlv1.bm90aGluZw.bm90aGluZw',
      amountPaise: 620_000, merchantId: 'mer_bigbasket',
    });

    expect(response.statusCode).toBe(401);

    const after = await pool.query(
      `SELECT count(*)::int AS n FROM payments WHERE mandate_id = $1`, [MANDATE],
    );
    expect(after.rows[0].n).toBe(before.rows[0].n);
  });
});

describe('a voucher permits exactly ONE payment', () => {
  it('refuses a second redemption of the same voucher', async () => {
    const { token } = await authorize(107_000);

    const first = await signedCall('/v1/payments', {
      voucher: token, amountPaise: 107_000, merchantId: 'mer_bigbasket',
    });
    const second = await signedCall('/v1/payments', {
      voucher: token, amountPaise: 107_000, merchantId: 'mer_bigbasket',
    });

    expect(first.response.statusCode).toBe(201);
    expect(second.response.statusCode).toBe(409);
    expect(second.body.error).toBe('voucher_already_used');
  });

  it('yields exactly one payment row under CONCURRENT redemption', async () => {
    // THE RACE THE DATABASE CONSTRAINT EXISTS FOR. An application-level
    // "have we seen this jti?" check would let both of these through.
    const { token } = await authorize(108_000);

    const results = await Promise.all([
      signedCall('/v1/payments', { voucher: token, amountPaise: 108_000, merchantId: 'mer_bigbasket' }),
      signedCall('/v1/payments', { voucher: token, amountPaise: 108_000, merchantId: 'mer_bigbasket' }),
      signedCall('/v1/payments', { voucher: token, amountPaise: 108_000, merchantId: 'mer_bigbasket' }),
    ]);

    const created = results.filter((r) => r.response.statusCode === 201);
    const refused = results.filter((r) => r.response.statusCode === 409);

    expect(created).toHaveLength(1);
    expect(refused).toHaveLength(2);

    const rows = await pool.query(
      `SELECT count(*)::int AS n FROM payments WHERE amount_paise = 108000 AND mandate_id = $1`,
      [MANDATE],
    );
    expect(rows.rows[0].n).toBe(1);
  });
});

describe('a voucher permits exactly one SPECIFIC payment', () => {
  it('refuses a different amount', async () => {
    // PREVENTS: getting a ₹1,240 approval and spending ₹99,999.
    const { token } = await authorize(109_000);

    const { response, body } = await signedCall('/v1/payments', {
      voucher: token, amountPaise: 999_900, merchantId: 'mer_bigbasket',
    });

    expect(response.statusCode).toBe(409);
    expect(body.error).toBe('voucher_mismatch');
    expect(body.mismatchedFields).toContain('amountPaise');
  });

  it('refuses a different merchant', async () => {
    // PREVENTS: spending a grocery authorisation at a liquor store.
    const { token } = await authorize(110_000);

    const { response, body } = await signedCall('/v1/payments', {
      voucher: token, amountPaise: 110_000, merchantId: 'mer_zepto',
    });

    expect(response.statusCode).toBe(409);
    expect(body.mismatchedFields).toContain('merchantId');
  });

  it("refuses a voucher presented by a DIFFERENT agent", async () => {
    // A stolen voucher is useless: the thief cannot both sign as themselves and
    // present a voucher naming somebody else.
    const { token } = await authorize(111_000);

    const { response, body } = await signedCall(
      '/v1/payments',
      { voucher: token, amountPaise: 111_000, merchantId: 'mer_bigbasket' },
      { privateKey: other.priv, keyId: OTHER_KEY_ID },
    );

    expect(response.statusCode).toBe(409);
    expect(body.mismatchedFields).toContain('agentId');
  });
});

describe('provider failure is recorded honestly', () => {
  it('records a declined payment as failed, with a reason', async () => {
    // The mock rail declines any amount ending in 13 paise, so the failure path
    // is demonstrable on demand rather than requiring a real decline.
    const { token } = await authorize(100_013);

    const { response, body } = await signedCall('/v1/payments', {
      voucher: token, amountPaise: 100_013, merchantId: 'mer_bigbasket',
    });

    expect(response.statusCode).toBe(200);
    expect(body.status).toBe('failed');
    expect(String(body.failureReason)).toContain('SIMULATED');
  });

  it('a failed payment still consumes its voucher', async () => {
    // Otherwise a declined payment could be retried indefinitely against one
    // authorization, and each retry is a real attempt on a real rail.
    // 190,013 paise: under the 200,000 per-transaction limit (so it authorises)
    // and ending in 13 (so the mock rail declines it). An earlier version used
    // 200,013, which the PER_TXN_LIMIT rule blocked - so there was no voucher
    // to consume and the test measured nothing.
    const { token } = await authorize(190_013);

    await signedCall('/v1/payments', {
      voucher: token, amountPaise: 190_013, merchantId: 'mer_bigbasket',
    });
    const retry = await signedCall('/v1/payments', {
      voucher: token, amountPaise: 190_013, merchantId: 'mer_bigbasket',
    });

    expect(retry.response.statusCode).toBe(409);
    expect(retry.body.error).toBe('voucher_already_used');
  });

  it('records the failure in the audit chain', async () => {
    const { token } = await authorize(150_013);
    const { body } = await signedCall('/v1/payments', {
      voucher: token, amountPaise: 150_013, merchantId: 'mer_bigbasket',
    });

    const events = await pool.query<{ event_type: string }>(
      `SELECT event_type FROM audit_events WHERE subject_id = $1`, [body.paymentId],
    );

    expect(events.rows.map((r) => r.event_type)).toContain('PAYMENT_FAILED');
  });
});

describe('the payment endpoint is authenticated like everything else', () => {
  it('refuses an unsigned request', async () => {
    const response = await app.inject({
      method: 'POST', url: '/v1/payments',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify({ voucher: 'x'.repeat(30), amountPaise: 1, merchantId: 'mer_bigbasket' }),
    });

    expect(response.statusCode).toBe(401);
  });
});
