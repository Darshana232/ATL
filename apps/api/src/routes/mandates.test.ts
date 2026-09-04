/**
 * Mandate endpoints, end to end through app.inject().
 *
 * ISOLATION NOTE. These tests exercise the real routes, which open their own
 * transactions and COMMIT. mandate_versions and audit_events are append-only
 * by design, so the rows cannot be deleted afterwards - the same trade the
 * audit concurrency test makes. Fixtures use a fixed `*_test_routes` id
 * namespace (idempotent), and each created mandate gets a fresh generated id.
 * Rows accumulate in the dev database and are cleared by the full reset in
 * docs/DATABASE.md.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { adminDatabaseUrl, loadConfig, type Config } from '../config.js';
import { createLogger } from '../logger.js';
import { closePool, createPool, type Pool } from '../db/pool.js';
import { buildServer } from '../server.js';
import {
  FailingBankProvider,
  StaticBankProvider,
  type BankDetails,
} from '../providers/bank-lookup.js';
import { ADMIN_KEY_HEADER } from '../middleware/admin-auth.js';

const ADMIN_KEY = 'test-admin-key-that-is-long-enough-32';

const config: Config = loadConfig({
  ...process.env,
  NODE_ENV: 'test',
  LOG_LEVEL: 'fatal',
  ADMIN_API_KEY: ADMIN_KEY,
});
const logger = createLogger(config);

const HDFC: BankDetails = {
  ifsc: 'HDFC0000001',
  bank: 'HDFC Bank',
  bankCode: 'HDFC',
  branch: 'TULSIANI CHMBRS - NARIMAN PT',
  city: 'GREATER MUMBAI',
  state: 'MAHARASHTRA',
  supportsUpi: true,
};

const NO_UPI: BankDetails = { ...HDFC, ifsc: 'ICIC0000001', bank: 'ICICI Bank', supportsUpi: false };

const staticBank = new StaticBankProvider(
  new Map([
    [HDFC.ifsc, HDFC],
    [NO_UPI.ifsc, NO_UPI],
  ]),
);

let pool: Pool;
let app: ReturnType<typeof buildServer>;

const auth = { [ADMIN_KEY_HEADER]: ADMIN_KEY };

const validTerms = {
  perTxnLimitPaise: 200_000,
  windowLimitPaise: 500_000,
  windowKind: 'week',
  maxTxnPerHour: 5,
  validFrom: '2026-09-01T00:00:00Z',
  validTo: '2026-12-31T23:59:59Z',
} as const;

function createBody(overrides: Record<string, unknown> = {}) {
  return {
    userId: 'usr_test_routes',
    agentId: 'agt_test_routes',
    label: 'Route test mandate',
    terms: validTerms,
    merchantIds: ['mer_test_routes'],
    consentRef: `consent_routes_${Date.now()}`,
    consentAt: '2026-09-01T08:55:00Z',
    createdBy: 'admin_test',
    ...overrides,
  };
}

beforeAll(async () => {
  pool = createPool(config, logger, adminDatabaseUrl(config));

  // Idempotent fixtures - these tables are not append-only.
  await pool.query(
    `INSERT INTO merchants (id, legal_name, display_name, mcc, category)
     VALUES ('mer_test_routes','Route Test Pvt Ltd','Route Shop','5411','groceries')
     ON CONFLICT (id) DO NOTHING`,
  );
  await pool.query(
    `INSERT INTO users (id, external_ref_hash, display_name)
     VALUES ('usr_test_routes',$1,'Route User') ON CONFLICT (id) DO NOTHING`,
    ['c'.repeat(64)],
  );
  await pool.query(
    `INSERT INTO agents (id, display_name, vendor, agent_version)
     VALUES ('agt_test_routes','Route Agent','anthropic','1.0.0') ON CONFLICT (id) DO NOTHING`,
  );

  app = buildServer({ config, logger, pool, bankLookup: staticBank });
  await app.ready();
});

afterAll(async () => {
  await app.close();
  await closePool(pool, logger);
});

/** Create a mandate and return its id. */
async function createMandate(overrides: Record<string, unknown> = {}): Promise<string> {
  const response = await app.inject({
    method: 'POST',
    url: '/v1/mandates',
    headers: auth,
    payload: createBody(overrides),
  });

  expect(response.statusCode).toBe(201);
  return response.json().mandate.id as string;
}

describe('POST /v1/mandates', () => {
  it('creates a mandate with version 1', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/v1/mandates',
      headers: auth,
      payload: createBody(),
    });

    expect(response.statusCode).toBe(201);

    const { mandate } = response.json();
    expect(mandate.id).toMatch(/^mnd_[a-z0-9]{20}$/);
    expect(mandate.status).toBe('active');
    expect(mandate.currentVersion.version).toBe(1);
    expect(mandate.currentVersion.terms.perTxnLimitPaise).toBe(200_000);
    expect(mandate.currentVersion.merchantIds).toEqual(['mer_test_routes']);
    expect(mandate.currentVersion.consentRef).toBeTruthy();
  });

  it('writes a hash-chained audit event in the SAME transaction', async () => {
    const mandateId = await createMandate();

    const { rows } = await pool.query<{ event_type: string; hash: string; payload: unknown }>(
      `SELECT event_type, hash, payload FROM audit_events WHERE mandate_id = $1`,
      [mandateId],
    );

    expect(rows).toHaveLength(1);
    expect(rows[0]?.event_type).toBe('MANDATE_CREATED');
    expect(rows[0]?.hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('records only allowlisted fields in the audit payload', async () => {
    // The payload is built from an explicit allowlist, never by spreading the
    // request - so a field added to the API later stays out of the hashed
    // trail until someone puts it there deliberately.
    const mandateId = await createMandate();

    const { rows } = await pool.query<{ payload: Record<string, unknown> }>(
      `SELECT payload FROM audit_events WHERE mandate_id = $1`,
      [mandateId],
    );

    const payload = rows[0]?.payload ?? {};
    expect(Object.keys(payload).sort()).toEqual(
      [
        'agentId', 'bankLookup', 'bankLookupDegraded', 'changeReason', 'consentAt',
        'consentRef', 'label', 'mandateId', 'merchantIds', 'terms', 'userId', 'version',
      ].sort(),
    );
  });

  it('accepts an EMPTY allowlist, meaning no merchant is permitted', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/v1/mandates',
      headers: auth,
      payload: createBody({ merchantIds: [] }),
    });

    expect(response.statusCode).toBe(201);
    expect(response.json().mandate.currentVersion.merchantIds).toEqual([]);
  });
});

describe('POST /v1/mandates - rejections', () => {
  it('401s without the admin key', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/v1/mandates',
      payload: createBody(),
    });

    expect(response.statusCode).toBe(401);
    expect(response.json().error).toBe('unauthorized');
  });

  it('401s with a wrong admin key', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/v1/mandates',
      headers: { [ADMIN_KEY_HEADER]: 'wrong-key-but-also-long-enough-to-pass' },
      payload: createBody(),
    });

    expect(response.statusCode).toBe(401);
  });

  it('400s on an unknown field rather than silently ignoring it', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/v1/mandates',
      headers: auth,
      payload: { ...createBody(), spendingLimit: 999999 },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json().error).toBe('validation_failed');
  });

  it('400s on incoherent terms, naming the field', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/v1/mandates',
      headers: auth,
      payload: createBody({
        terms: { ...validTerms, perTxnLimitPaise: 900_000, windowLimitPaise: 500_000 },
      }),
    });

    expect(response.statusCode).toBe(400);
    expect(
      response.json().issues.map((issue: { field: string }) => issue.field),
    ).toContain('perTxnLimitPaise');
  });

  it('400s (not 500s) when a referenced user does not exist', async () => {
    // Without the error mapping this would surface as an opaque 500 and the
    // caller would have to guess what was wrong.
    const response = await app.inject({
      method: 'POST',
      url: '/v1/mandates',
      headers: auth,
      payload: createBody({ userId: 'usr_test_nonexistent' }),
    });

    expect(response.statusCode).toBe(400);
    expect(
      response.json().issues.map((issue: { field: string }) => issue.field),
    ).toContain('userId');
  });

  it('400s (not 500s) when consent is dated after the change it authorises', async () => {
    // REGRESSION TEST. Found by a live smoke test, not by the suite: every
    // in-process test happened to use a consentAt in the past, so the
    // mandate_versions_consent_not_after_creation CHECK never fired. In the
    // real run it did, and surfaced as an opaque 500.
    //
    // A constraint we deliberately added must produce an explanation.
    const response = await app.inject({
      method: 'POST',
      url: '/v1/mandates',
      headers: auth,
      payload: createBody({ consentAt: '2099-01-01T00:00:00Z' }),
    });

    expect(response.statusCode).toBe(400);
    expect(
      response.json().issues.map((issue: { field: string }) => issue.field),
    ).toContain('consentAt');
  });

  it('is ATOMIC: a failed allowlist insert leaves no mandate behind', async () => {
    // The merchant does not exist, so the allowlist insert fails AFTER the
    // mandate and version rows. If the transaction were not wrapping all of
    // it, a half-created mandate would survive.
    const before = await pool.query<{ count: number }>(`SELECT count(*)::bigint AS count FROM mandates`);

    const response = await app.inject({
      method: 'POST',
      url: '/v1/mandates',
      headers: auth,
      payload: createBody({ merchantIds: ['mer_test_nonexistent'] }),
    });

    expect(response.statusCode).toBe(400);

    const after = await pool.query<{ count: number }>(`SELECT count(*)::bigint AS count FROM mandates`);
    expect(after.rows[0]?.count).toBe(before.rows[0]?.count);
  });
});

describe('cold-path bank lookup', () => {
  it('includes bank context when the IFSC resolves', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/v1/mandates',
      headers: auth,
      payload: createBody({ ifsc: 'HDFC0000001' }),
    });

    expect(response.statusCode).toBe(201);
    expect(response.json().bankContext).toMatchObject({
      bank: 'HDFC Bank',
      supportsUpi: true,
    });
  });

  it('warns, but still creates, when the branch does not support UPI', async () => {
    // Advisory only. We do not operate the rail and must not refuse a mandate
    // on a third party's say-so.
    const response = await app.inject({
      method: 'POST',
      url: '/v1/mandates',
      headers: auth,
      payload: createBody({ ifsc: 'ICIC0000001' }),
    });

    expect(response.statusCode).toBe(201);
    expect(response.json().warnings.join(' ')).toMatch(/does not report UPI support/);
  });

  it('DEGRADES GRACEFULLY: the mandate is created even when lookup fails', async () => {
    // A compliance system must not be unable to create a mandate because a
    // third party is down.
    const degradedApp = buildServer({
      config,
      logger,
      pool,
      bankLookup: new FailingBankProvider(),
    });
    await degradedApp.ready();

    try {
      const response = await degradedApp.inject({
        method: 'POST',
        url: '/v1/mandates',
        headers: auth,
        payload: createBody({ ifsc: 'HDFC0000001' }),
      });

      expect(response.statusCode).toBe(201);
      expect(response.json().bankContext).toBeNull();
      expect(response.json().warnings.join(' ')).toMatch(/unavailable/i);
    } finally {
      await degradedApp.close();
    }
  });

  it('records the degradation in the audit trail rather than hiding it', async () => {
    const degradedApp = buildServer({
      config, logger, pool, bankLookup: new FailingBankProvider(),
    });
    await degradedApp.ready();

    try {
      const response = await degradedApp.inject({
        method: 'POST',
        url: '/v1/mandates',
        headers: auth,
        payload: createBody({ ifsc: 'HDFC0000001' }),
      });
      const mandateId = response.json().mandate.id;

      const { rows } = await pool.query<{ payload: { bankLookupDegraded: boolean } }>(
        `SELECT payload FROM audit_events WHERE mandate_id = $1`,
        [mandateId],
      );

      expect(rows[0]?.payload.bankLookupDegraded).toBe(true);
    } finally {
      await degradedApp.close();
    }
  });

  it('400s on a malformed IFSC - a caller error, not a degradation', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/v1/mandates',
      headers: auth,
      payload: createBody({ ifsc: 'NOTANIFSC' }),
    });

    expect(response.statusCode).toBe(400);
  });
});

describe('GET /v1/mandates/:id', () => {
  it('returns the mandate with its current version', async () => {
    const mandateId = await createMandate();

    const response = await app.inject({ method: 'GET', url: `/v1/mandates/${mandateId}` });

    expect(response.statusCode).toBe(200);
    expect(response.json().mandate.id).toBe(mandateId);
  });

  it('404s for an unknown mandate', async () => {
    const response = await app.inject({ method: 'GET', url: '/v1/mandates/mnd_test_missing' });

    expect(response.statusCode).toBe(404);
    expect(response.json().error).toBe('not_found');
  });
});

describe('POST /v1/mandates/:id/versions', () => {
  it('adds a version and returns it', async () => {
    const mandateId = await createMandate();

    const response = await app.inject({
      method: 'POST',
      url: `/v1/mandates/${mandateId}/versions`,
      headers: auth,
      payload: {
        terms: { ...validTerms, perTxnLimitPaise: 400_000 },
        merchantIds: ['mer_test_routes'],
        consentRef: 'consent_routes_v2',
        consentAt: '2026-09-02T10:00:00Z',
        createdBy: 'admin_test',
        changeReason: 'raised limit',
      },
    });

    expect(response.statusCode).toBe(201);
    expect(response.json().version.version).toBe(2);
    expect(response.json().version.terms.perTxnLimitPaise).toBe(400_000);
  });

  it('THE GUARANTEE: version 1 still reports its original limit', async () => {
    // End to end, over HTTP: a decision made under version 1 remains
    // explainable against version 1's numbers after version 2 raised them.
    const mandateId = await createMandate();

    await app.inject({
      method: 'POST',
      url: `/v1/mandates/${mandateId}/versions`,
      headers: auth,
      payload: {
        terms: { ...validTerms, perTxnLimitPaise: 400_000 },
        merchantIds: ['mer_test_routes'],
        consentRef: 'consent_routes_v2b',
        consentAt: '2026-09-02T10:00:00Z',
        createdBy: 'admin_test',
      },
    });

    const v1 = await app.inject({ method: 'GET', url: `/v1/mandates/${mandateId}/versions/1` });
    const current = await app.inject({ method: 'GET', url: `/v1/mandates/${mandateId}` });

    expect(v1.json().version.terms.perTxnLimitPaise).toBe(200_000); // untouched
    expect(current.json().mandate.currentVersion.terms.perTxnLimitPaise).toBe(400_000);
  });

  it('lists the full version history', async () => {
    const mandateId = await createMandate();

    await app.inject({
      method: 'POST',
      url: `/v1/mandates/${mandateId}/versions`,
      headers: auth,
      payload: {
        terms: validTerms,
        merchantIds: [],
        consentRef: 'consent_routes_v2c',
        consentAt: '2026-09-02T10:00:00Z',
        createdBy: 'admin_test',
      },
    });

    const response = await app.inject({ method: 'GET', url: `/v1/mandates/${mandateId}/versions` });

    expect(response.statusCode).toBe(200);
    expect(response.json().versions.map((v: { version: number }) => v.version)).toEqual([1, 2]);
  });

  it('404s for a version that does not exist', async () => {
    const mandateId = await createMandate();

    const response = await app.inject({
      method: 'GET',
      url: `/v1/mandates/${mandateId}/versions/99`,
    });

    expect(response.statusCode).toBe(404);
  });

  it('400s on a non-numeric version in the path', async () => {
    const mandateId = await createMandate();

    const response = await app.inject({
      method: 'GET',
      url: `/v1/mandates/${mandateId}/versions/latest`,
    });

    expect(response.statusCode).toBe(400);
  });
});

describe('POST /v1/mandates/:id/revoke', () => {
  it('revokes and records who and why', async () => {
    const mandateId = await createMandate();

    const response = await app.inject({
      method: 'POST',
      url: `/v1/mandates/${mandateId}/revoke`,
      headers: auth,
      payload: { revokedBy: 'usr_test_routes', revokedReason: 'user withdrew consent' },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().mandate.status).toBe('revoked');
    expect(response.json().mandate.revokedReason).toBe('user withdrew consent');
  });

  it('409s on a second revocation, because revocation is terminal', async () => {
    const mandateId = await createMandate();
    const payload = { revokedBy: 'usr_test_routes', revokedReason: 'first' };

    await app.inject({
      method: 'POST', url: `/v1/mandates/${mandateId}/revoke`, headers: auth, payload,
    });
    const second = await app.inject({
      method: 'POST', url: `/v1/mandates/${mandateId}/revoke`, headers: auth,
      payload: { ...payload, revokedReason: 'second' },
    });

    expect(second.statusCode).toBe(409);
    expect(second.json().error).toBe('already_revoked');
  });

  it('writes exactly ONE revocation event, not one per attempt', async () => {
    // An audit trail full of no-op "revoked" entries would misrepresent what
    // actually happened.
    const mandateId = await createMandate();
    const payload = { revokedBy: 'usr_test_routes', revokedReason: 'once' };

    await app.inject({ method: 'POST', url: `/v1/mandates/${mandateId}/revoke`, headers: auth, payload });
    await app.inject({ method: 'POST', url: `/v1/mandates/${mandateId}/revoke`, headers: auth, payload });

    const { rows } = await pool.query<{ count: number }>(
      `SELECT count(*)::bigint AS count FROM audit_events
        WHERE mandate_id = $1 AND event_type = 'MANDATE_REVOKED'`,
      [mandateId],
    );

    expect(rows[0]?.count).toBe(1);
  });

  it('409s when adding a version to a revoked mandate', async () => {
    const mandateId = await createMandate();

    await app.inject({
      method: 'POST', url: `/v1/mandates/${mandateId}/revoke`, headers: auth,
      payload: { revokedBy: 'usr_test_routes', revokedReason: 'done' },
    });

    const response = await app.inject({
      method: 'POST',
      url: `/v1/mandates/${mandateId}/versions`,
      headers: auth,
      payload: {
        terms: validTerms,
        merchantIds: [],
        consentRef: 'consent_routes_after_revoke',
        consentAt: '2026-09-02T10:00:00Z',
        createdBy: 'admin_test',
      },
    });

    expect(response.statusCode).toBe(409);
    expect(response.json().error).toBe('mandate_revoked');
  });

  it('400s on a revocation with no reason', async () => {
    const mandateId = await createMandate();

    const response = await app.inject({
      method: 'POST',
      url: `/v1/mandates/${mandateId}/revoke`,
      headers: auth,
      payload: { revokedBy: 'usr_test_routes' },
    });

    expect(response.statusCode).toBe(400);
  });
});

describe('the audit chain stays intact across many route calls', () => {
  it('every event links to its predecessor', async () => {
    await createMandate();
    await createMandate();

    const { rows } = await pool.query<{ hash: string; prev_hash: string | null }>(
      `SELECT hash, prev_hash FROM audit_events WHERE chain_id = 'main' ORDER BY seq`,
    );

    expect(rows.length).toBeGreaterThan(1);
    expect(rows[0]?.prev_hash).toBeNull();

    for (let i = 1; i < rows.length; i += 1) {
      expect(rows[i]?.prev_hash).toBe(rows[i - 1]?.hash);
    }
  });
});
