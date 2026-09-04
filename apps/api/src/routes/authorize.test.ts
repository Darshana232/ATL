/**
 * POST /v1/authorize - end to end, over real HTTP (in-process), against a real
 * database, with real Ed25519 signatures.
 *
 * The unit tests proved each piece in isolation. This file proves they were
 * WIRED TOGETHER correctly, which is a different claim: every one of these
 * attacks would be stopped by a correct implementation and let through by a
 * plausible-looking wiring mistake.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { generateKeyPairSync, createHash, randomBytes } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { loadConfig, type Config } from '../config.js';
import { createLogger } from '../logger.js';
import { closePool, createPool, type Pool } from '../db/pool.js';
import { buildServer } from '../server.js';
import { withTransaction } from '../db/transaction.js';
import { insertMandate } from '../repositories/mandate.js';
import { createMandateTerms } from '../domain/mandate.js';
import {
  hashBody, signRequest, KEY_HEADER, TIMESTAMP_HEADER,
  IDEMPOTENCY_HEADER, SIGNATURE_HEADER,
} from '../auth/signing.js';
import { verifyVoucher } from '../voucher/voucher.js';
import { NullRiskProvider } from '../providers/risk.js';

const config: Config = loadConfig({ ...process.env, NODE_ENV: 'test', LOG_LEVEL: 'fatal' });
const logger = createLogger(config);

/** A frozen "now" so time-window and validity rules are deterministic. */
const NOW = new Date('2026-09-07T08:52:00Z'); // Monday 14:22 IST

const suffix = randomBytes(4).toString('hex');
const AGENT = `agt_authz_${suffix}`;
const OTHER_AGENT = `agt_other_${suffix}`;
const USER = `usr_authz_${suffix}`;
const MANDATE = `mnd_authz_${suffix}`;
const OTHER_MANDATE = `mnd_other_${suffix}`;
const KEY_ID = `akid_authz_${suffix}`;
const OTHER_KEY_ID = `akid_other_${suffix}`;
const REVOKED_KEY_ID = `akid_revoked_${suffix}`;
const SUSPENDED_KEY_ID = `akid_susp_${suffix}`;
const SUSPENDED_AGENT = `agt_susp_${suffix}`;

let pool: Pool;
let app: FastifyInstance;

function keypair() {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const spki = publicKey.export({ type: 'spki', format: 'der' }).toString('base64');
  return {
    spki,
    fingerprint: createHash('sha256').update(spki).digest('hex'),
    priv: privateKey.export({ type: 'pkcs8', format: 'der' }).toString('base64'),
  };
}

const main = keypair();
const other = keypair();
const revoked = keypair();
const suspended = keypair();

const TERMS = createMandateTerms({
  perTxnLimitPaise: 200_000,   // ₹2,000
  windowLimitPaise: 500_000,   // ₹5,000 per week
  windowKind: 'week',
  maxTxnPerHour: 5,
  blockedMccs: ['5921', '7995'],
  timezone: 'Asia/Kolkata',
  windowStartHour: 8,
  windowEndHour: 20,
  allowedWeekdays: ['MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT'],
  validFrom: new Date('2026-09-01T00:00:00Z'),
  validTo: new Date('2026-12-31T23:59:59Z'),
  paymentMethods: ['upi_reserve_pay'],
});

beforeAll(async () => {
  pool = createPool(config, logger);
  app = buildServer({ config, logger, pool, now: () => NOW });
  await app.ready();

  await withTransaction(pool, async (tx) => {
    await tx.query(
      `INSERT INTO users (id, external_ref_hash, display_name)
       VALUES ($1,$2,'Authz Test User')`,
      [USER, createHash('sha256').update(USER).digest('hex')],
    );

    for (const [id, status] of [
      [AGENT, 'active'], [OTHER_AGENT, 'active'], [SUSPENDED_AGENT, 'suspended'],
    ] as const) {
      await tx.query(
        `INSERT INTO agents (id, display_name, vendor, agent_version, status, suspended_at)
         VALUES ($1,'Authz Test Agent','test','1.0.0',$2,
                 CASE WHEN $2 <> 'active' THEN now() ELSE NULL END)`,
        [id, status],
      );
    }

    const credentials: [string, string, ReturnType<typeof keypair>, string, string][] = [
      [`cred_a_${suffix}`, AGENT, main, KEY_ID, 'active'],
      [`cred_b_${suffix}`, OTHER_AGENT, other, OTHER_KEY_ID, 'active'],
      [`cred_r_${suffix}`, AGENT, revoked, REVOKED_KEY_ID, 'revoked'],
      [`cred_s_${suffix}`, SUSPENDED_AGENT, suspended, SUSPENDED_KEY_ID, 'active'],
    ];

    for (const [id, agentId, key, keyId, status] of credentials) {
      await tx.query(
        `INSERT INTO agent_credentials
           (id, agent_id, key_id, public_key_spki_b64, public_key_fingerprint, status, revoked_at)
         VALUES ($1,$2,$3,$4,$5,$6, CASE WHEN $6='revoked' THEN now() ELSE NULL END)`,
        [id, agentId, keyId, key.spki, key.fingerprint, status],
      );
    }

    await insertMandate(tx, {
      mandateId: MANDATE, userId: USER, agentId: AGENT, label: 'Authz test mandate',
      terms: TERMS, merchantIds: ['mer_bigbasket'], createdBy: 'test',
      changeReason: null, consentRef: 'consent_test', consentAt: new Date('2026-09-01T00:00:00Z'),
    });

    // Belongs to a DIFFERENT agent - the MANDATE_AGENT_MATCH fixture.
    await insertMandate(tx, {
      mandateId: OTHER_MANDATE, userId: USER, agentId: OTHER_AGENT, label: "Someone else's",
      terms: TERMS, merchantIds: ['mer_bigbasket'], createdBy: 'test',
      changeReason: null, consentRef: 'consent_test', consentAt: new Date('2026-09-01T00:00:00Z'),
    });
  });
});

afterAll(async () => {
  await app.close();
  await closePool(pool, logger);
});

/* ------------------------------------------------------------------------ */
/* Signing helper                                                           */
/* ------------------------------------------------------------------------ */

interface CallOptions {
  readonly body?: Record<string, unknown>;
  /** The bytes actually SENT, when they must differ from what was signed. */
  readonly sendBody?: string;
  readonly privateKey?: string;
  readonly keyId?: string;
  readonly timestamp?: string;
  readonly idempotencyKey?: string;
  readonly signature?: string;
  readonly omit?: readonly string[];
  readonly instance?: FastifyInstance;
}

function defaultBody(): Record<string, unknown> {
  return {
    mandateId: MANDATE,
    merchantId: 'mer_bigbasket',
    amountPaise: 124_000,
    paymentMethod: 'upi_reserve_pay',
  };
}

async function call(options: CallOptions = {}) {
  const payload = JSON.stringify(options.body ?? defaultBody());
  const sent = options.sendBody ?? payload;

  const parts = {
    method: 'POST',
    path: '/v1/authorize',
    timestamp: options.timestamp ?? NOW.toISOString(),
    keyId: options.keyId ?? KEY_ID,
    idempotencyKey: options.idempotencyKey ?? `idem_${randomBytes(8).toString('hex')}`,
    bodySha256: hashBody(payload),
  };

  const headers: Record<string, string> = {
    'content-type': 'application/json',
    [KEY_HEADER]: parts.keyId,
    [TIMESTAMP_HEADER]: parts.timestamp,
    [IDEMPOTENCY_HEADER]: parts.idempotencyKey,
    [SIGNATURE_HEADER]: options.signature ?? signRequest(options.privateKey ?? main.priv, parts),
  };

  for (const header of options.omit ?? []) delete headers[header];

  const response = await (options.instance ?? app).inject({
    method: 'POST', url: '/v1/authorize', headers, payload: sent,
  });

  return { response, body: response.json() as Record<string, unknown>, idempotencyKey: parts.idempotencyKey };
}

/* ------------------------------------------------------------------------ */
/* Happy path                                                               */
/* ------------------------------------------------------------------------ */

describe('a compliant, correctly signed request', () => {
  it('returns PASS with a full rule breakdown and a voucher', async () => {
    const { response, body } = await call();

    expect(response.statusCode).toBe(200);
    expect(body.verdict).toBe('PASS');
    expect(body.evaluations).toHaveLength(13);
    expect(body.engineVersion).toBe('engine-v2');
    expect(body.voucher).not.toBeNull();
  });

  it('mints a voucher that verifies and carries the payment constraints', async () => {
    // The voucher IS the product. It must name exactly one payment.
    const { body } = await call();
    const token = (body.voucher as unknown as { token: string }).token;

    const result = verifyVoucher(config.VOUCHER_SIGNING_SECRET!, token, NOW);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.claims.amountPaise).toBe(124_000);
      expect(result.claims.merchantId).toBe('mer_bigbasket');
      expect(result.claims.mandateId).toBe(MANDATE);
      expect(result.claims.agentId).toBe(AGENT);
    }
  });

  it('labels the simulated rail on every response', async () => {
    // CLAUDE.md section 33: a simulated rail must never be presented as a real
    // integration. In the contract, not only in the README.
    const { body } = await call();
    expect(String(body.simulation)).toContain('SIMULATED');
  });

  it('records the request, the decision and all 13 rule rows', async () => {
    const { body } = await call();

    const rules = await pool.query(
      `SELECT rule_code, verdict FROM rule_evaluations WHERE decision_id = $1 ORDER BY sequence`,
      [body.decisionId],
    );

    expect(rules.rowCount).toBe(13);
    // Including the passes: "we did check the merchant" is what an auditor asks.
    expect(rules.rows.map((r: { rule_code: string }) => r.rule_code)[0]).toBe('MANDATE_AGENT_MATCH');
  });

  it('writes an AUTHORIZATION_DECIDED event into the hash chain', async () => {
    const { body } = await call();

    const events = await pool.query(
      `SELECT event_type, actor_id, hash, prev_hash FROM audit_events
        WHERE subject_id = $1 AND subject_kind = 'decision'`,
      [body.decisionId],
    );

    expect(events.rowCount).toBe(1);
    expect(events.rows[0].event_type).toBe('AUTHORIZATION_DECIDED');
    expect(events.rows[0].actor_id).toBe(AGENT);
  });

  it('records the spend window that was actually used', async () => {
    // Not recoverable later: refunds and time change what "spent this week"
    // evaluates to. Reference what you can reconstruct, STORE what you cannot.
    const { body } = await call();

    const decision = await pool.query(
      `SELECT spend_window_start, spend_window_end, spent_before_paise
         FROM decisions WHERE id = $1`, [body.decisionId],
    );

    const row = decision.rows[0];
    expect(new Date(row.spend_window_start).toISOString()).toBe('2026-09-06T18:30:00.000Z');
    expect(Number(row.spent_before_paise)).toBeGreaterThanOrEqual(0);
  });
});

/* ------------------------------------------------------------------------ */
/* Blocking                                                                 */
/* ------------------------------------------------------------------------ */

describe('a blocked request', () => {
  it('returns 200 with BLOCK and NO voucher', async () => {
    // 200 because the decision is the resource and producing it succeeded. The
    // safety is structural: there is no token to present, so a client that
    // ignores `verdict` entirely still cannot pay.
    const { response, body } = await call({
      body: { ...defaultBody(), amountPaise: 620_000 },
    });

    expect(response.statusCode).toBe(200);
    expect(body.verdict).toBe('BLOCK');
    expect(body.voucher).toBeNull();
  });

  it('explains itself with the actual numbers', async () => {
    const { body } = await call({ body: { ...defaultBody(), amountPaise: 620_000 } });

    expect(body.reason).toContain('₹6,200.00');
    expect(body.reason).toContain('₹2,000.00');
    expect(body.reason).toContain('₹4,200.00');
  });

  it('still evaluates every rule after the blocking one', async () => {
    const { body } = await call({ body: { ...defaultBody(), amountPaise: 620_000 } });
    const codes = (body.evaluations as unknown as { ruleCode: string }[]).map((e) => e.ruleCode);

    expect(codes).toContain('MERCHANT_ALLOWLIST');
    expect(codes).toContain('RISK_SIGNAL');
  });

  it('BLOCKS a merchant that is not on the allowlist', async () => {
    const { body } = await call({ body: { ...defaultBody(), merchantId: 'mer_zomato' } });

    expect(body.verdict).toBe('BLOCK');
    expect(body.voucher).toBeNull();
  });

  it('BLOCKS a blocked merchant category', async () => {
    const { body } = await call({ body: { ...defaultBody(), merchantId: 'mer_city_wines' } });
    expect(body.verdict).toBe('BLOCK');
  });

  it("BLOCKS an agent using someone else's mandate, and records why", async () => {
    // THE HOLE THIS CLOSES: without MANDATE_AGENT_MATCH, any agent with a valid
    // key could spend against any mandate in the system.
    const { response, body } = await call({ body: { ...defaultBody(), mandateId: OTHER_MANDATE } });

    expect(response.statusCode).toBe(200);
    expect(body.verdict).toBe('BLOCK');
    expect(body.voucher).toBeNull();
    expect(body.reason).toContain('not transferable');

    // It left a decision behind, which a 403 would not have.
    const rows = await pool.query(
      `SELECT verdict FROM rule_evaluations
        WHERE decision_id = $1 AND rule_code = 'MANDATE_AGENT_MATCH'`,
      [body.decisionId],
    );
    expect(rows.rows[0].verdict).toBe('BLOCK');
  });
});

/* ------------------------------------------------------------------------ */
/* Authentication attacks                                                   */
/* ------------------------------------------------------------------------ */

describe('authentication rejects every forgery', () => {
  const expect401 = (response: { statusCode: number }) => expect(response.statusCode).toBe(401);

  it('rejects an unsigned request', async () => {
    const response = await app.inject({
      method: 'POST', url: '/v1/authorize',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify(defaultBody()),
    });
    expect401(response);
  });

  it('rejects a request missing any single header', async () => {
    for (const header of [KEY_HEADER, TIMESTAMP_HEADER, IDEMPOTENCY_HEADER, SIGNATURE_HEADER]) {
      const { response } = await call({ omit: [header] });
      expect(response.statusCode, `missing ${header}`).toBe(401);
    }
  });

  it('rejects a tampered body - ONE PAISA is enough', async () => {
    // PREVENTS: intercepting a ₹1,240 authorization and turning it into ₹99,999
    // while keeping the signature.
    const signed = defaultBody();
    const sent = JSON.stringify({ ...signed, amountPaise: 124_001 });

    const { response } = await call({ body: signed, sendBody: sent });
    expect401(response);
  });

  it("rejects a signature made with another agent's key", async () => {
    const { response } = await call({ privateKey: other.priv });
    expect401(response);
  });

  it("rejects presenting another agent's key id with your own signature", async () => {
    const { response } = await call({ keyId: OTHER_KEY_ID });
    expect401(response);
  });

  it('rejects a stale timestamp', async () => {
    const stale = new Date(NOW.getTime() - 6 * 60_000).toISOString();
    const { response } = await call({ timestamp: stale });
    expect401(response);
  });

  it('rejects a far-future timestamp', async () => {
    const { response } = await call({ timestamp: '2030-01-01T00:00:00.000Z' });
    expect401(response);
  });

  it('rejects an unknown key id', async () => {
    const { response } = await call({ keyId: 'akid_nobody_here' });
    expect401(response);
  });

  it('rejects a REVOKED credential', async () => {
    const { response } = await call({ keyId: REVOKED_KEY_ID, privateKey: revoked.priv });
    expect401(response);
  });

  it('rejects an active credential belonging to a SUSPENDED agent', async () => {
    // Suspending an agent must disable every key it holds at once, without
    // anyone revoking each one individually.
    const { response } = await call({ keyId: SUSPENDED_KEY_ID, privateKey: suspended.priv });
    expect401(response);
  });

  it('rejects a header containing a newline', async () => {
    // PREVENTS: injecting an extra line into the signing string - header
    // injection applied to a signature.
    const { response } = await call({ idempotencyKey: 'idem_abc\nextra' });
    expect401(response);
  });

  it('rejects a malformed timestamp instead of treating it as the epoch', async () => {
    const { response } = await call({ timestamp: 'yesterday-ish' });
    expect401(response);
  });

  it('rejects an empty body', async () => {
    const { response } = await call({ sendBody: '' });
    expect401(response);
  });

  it('rejects an over-long header', async () => {
    // Cheap denial-of-service control: these are read before anything else.
    const { response } = await call({ idempotencyKey: 'i'.repeat(300) });
    expect401(response);
  });

  it('gives the SAME answer for every rejection reason', async () => {
    // Probing must not be able to map our state: "no such key" and "revoked
    // key" and "bad signature" are one message to the outside world.
    const cases = await Promise.all([
      call({ keyId: 'akid_nobody_here' }),
      call({ keyId: REVOKED_KEY_ID, privateKey: revoked.priv }),
      call({ privateKey: other.priv }),
    ]);

    const messages = new Set(cases.map((c) => String(c.body.message)));
    expect(messages.size).toBe(1);
  });

  it('records rejected attempts in the audit chain', async () => {
    await call({ privateKey: other.priv });

    const events = await pool.query(
      `SELECT count(*)::int AS n FROM audit_events WHERE event_type = 'AGENT_AUTH_REJECTED'`,
    );
    expect(events.rows[0].n).toBeGreaterThan(0);
  });

  it('leaks nothing in a rejection body', async () => {
    const { body } = await call({ privateKey: other.priv });
    const text = JSON.stringify(body);

    for (const term of ['stack', 'postgres', 'select', 'agent_credentials', 'ed25519 private']) {
      expect(text.toLowerCase(), `a 401 body must not mention "${term}"`).not.toContain(term);
    }
  });
});

/* ------------------------------------------------------------------------ */
/* Idempotency and replay                                                   */
/* ------------------------------------------------------------------------ */

describe('idempotency is also our replay defence', () => {
  it('returns the ORIGINAL decision when the same request is replayed', async () => {
    const key = `idem_${randomBytes(8).toString('hex')}`;

    const first = await call({ idempotencyKey: key });
    const second = await call({ idempotencyKey: key });

    expect(first.body.decisionId).toBe(second.body.decisionId);
    expect(second.body.idempotentReplay).toBe(true);
    expect(first.body.idempotentReplay).toBe(false);
  });

  it('creates exactly ONE decision, however many times it is replayed', async () => {
    // PREVENTS: a network retry - or a captured request re-sent by an attacker
    // - becoming a second charge.
    const key = `idem_${randomBytes(8).toString('hex')}`;

    await call({ idempotencyKey: key });
    await call({ idempotencyKey: key });
    await call({ idempotencyKey: key });

    const rows = await pool.query(
      `SELECT count(*)::int AS n FROM authorization_requests
        WHERE agent_id = $1 AND idempotency_key = $2`, [AGENT, key],
    );
    expect(rows.rows[0].n).toBe(1);
  });

  it('replays the same voucher jti, so the payment cap still holds', async () => {
    // One jti per DECISION means payments.voucher_jti UNIQUE caps the whole
    // decision at one payment however many times it is retried.
    const key = `idem_${randomBytes(8).toString('hex')}`;

    const first = await call({ idempotencyKey: key });
    const second = await call({ idempotencyKey: key });

    expect((first.body.voucher as unknown as { jti: string }).jti)
      .toBe((second.body.voucher as unknown as { jti: string }).jti);
  });

  it('scopes idempotency PER AGENT', async () => {
    // Two agents may legitimately choose the same key, and one must never be
    // able to squat another's key space.
    const key = `idem_shared_${randomBytes(6).toString('hex')}`;

    const mine = await call({ idempotencyKey: key });
    const theirs = await call({
      idempotencyKey: key, keyId: OTHER_KEY_ID, privateKey: other.priv,
      body: { ...defaultBody(), mandateId: OTHER_MANDATE },
    });

    expect(mine.body.decisionId).not.toBe(theirs.body.decisionId);
  });

  it('survives a concurrent race on the same key', async () => {
    // Both requests get past the read, both try to insert, the UNIQUE
    // constraint refuses one - and we resolve it into the winner's decision
    // rather than a 500.
    const key = `idem_race_${randomBytes(8).toString('hex')}`;

    const [a, b] = await Promise.all([
      call({ idempotencyKey: key }),
      call({ idempotencyKey: key }),
    ]);

    expect(a.response.statusCode).toBe(200);
    expect(b.response.statusCode).toBe(200);
    expect(a.body.decisionId).toBe(b.body.decisionId);
  });
});

/* ------------------------------------------------------------------------ */
/* Validation and not-found                                                 */
/* ------------------------------------------------------------------------ */

describe('malformed and unknown input', () => {
  it('rejects an unknown field rather than silently dropping it', async () => {
    // z.strictObject. A silently ignored "dailyLimit" would look accepted.
    const { response, body } = await call({ body: { ...defaultBody(), sneaky: true } });

    expect(response.statusCode).toBe(400);
    expect(body.error).toBe('validation_failed');
  });

  it('rejects a non-integer amount', async () => {
    const { response } = await call({ body: { ...defaultBody(), amountPaise: 1240.5 } });
    expect(response.statusCode).toBe(400);
  });

  it('rejects a zero or negative amount', async () => {
    for (const amount of [0, -1]) {
      const { response } = await call({ body: { ...defaultBody(), amountPaise: amount } });
      expect(response.statusCode, `amount ${amount}`).toBe(400);
    }
  });

  it('answers 404 for an unknown mandate', async () => {
    const { response, body } = await call({ body: { ...defaultBody(), mandateId: 'mnd_nope' } });

    expect(response.statusCode).toBe(404);
    expect(body.error).toBe('mandate_not_found');
  });

  it('answers 404 for an unknown merchant', async () => {
    const { response, body } = await call({ body: { ...defaultBody(), merchantId: 'mer_nope' } });

    expect(response.statusCode).toBe(404);
    expect(body.error).toBe('merchant_not_found');
  });

  it('rejects a SQL-injection-shaped id at the boundary', async () => {
    const { response } = await call({
      body: { ...defaultBody(), mandateId: "mnd_x'; DROP TABLE payments; --" },
    });
    expect(response.statusCode).toBe(400);
  });
});

/* ------------------------------------------------------------------------ */
/* Degradation                                                              */
/* ------------------------------------------------------------------------ */

describe('a degraded risk provider cannot change a verdict', () => {
  it('still authorizes when no risk signal is available', async () => {
    // ADR-0010: risk is advisory. If the provider is down, blocking every
    // payment and allowing every payment are both wrong; the right answer is
    // to decide without it and record that we had no signal.
    const quiet = buildServer({ config, logger, pool, risk: new NullRiskProvider(), now: () => NOW });
    await quiet.ready();

    try {
      const { response, body } = await call({ instance: quiet });

      expect(response.statusCode).toBe(200);
      expect(body.verdict).toBe('PASS');
      expect(body.risk).toBeNull();

      const skip = (body.evaluations as unknown as { ruleCode: string; verdict: string }[])
        .find((e) => e.ruleCode === 'RISK_SIGNAL');
      // SKIP, not PASS: "we did not ask" must stay distinguishable from
      // "we asked and it looked clean".
      expect(skip?.verdict).toBe('SKIP');
    } finally {
      await quiet.close();
    }
  });
});
