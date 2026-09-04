/**
 * Schema guarantees.
 *
 * These are integration tests against the real local PostgreSQL, because the
 * behaviour under test lives in Postgres - constraints, triggers, foreign
 * keys - not in our code. You cannot unit-test a trigger.
 *
 * TWO TESTING TECHNIQUES WORTH LEARNING FROM THIS FILE:
 *
 * 1. Isolation by ROLLBACK. Every test runs inside a transaction that is
 *    always rolled back, so tests cannot see or corrupt each other's rows and
 *    the database is unchanged afterwards. This matters especially here:
 *    mandate_versions is append-only, so the usual "DELETE the test rows"
 *    cleanup is impossible by design.
 *
 * 2. Assert the REASON, not merely that it failed. Every expected failure
 *    checks a specific SQLSTATE and, where applicable, the exact constraint
 *    name. Earlier in this phase a set of ad-hoc checks all "passed" while
 *    being rejected by the wrong constraint - eight rejections that looked
 *    like eight proofs. A test that passes for the wrong reason is worse than
 *    a failing test, because it manufactures confidence.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type pg from 'pg';
import { adminDatabaseUrl, loadConfig, type Config } from '../config.js';
import { createLogger } from '../logger.js';
import { closePool, createPool, type Pool } from './pool.js';

const config: Config = loadConfig({ ...process.env, NODE_ENV: 'test', LOG_LEVEL: 'fatal' });
const logger = createLogger(config);

let pool: Pool;

beforeAll(() => {
  /**
   * Connects as the OWNER, not as the service's atl_app role.
   *
   * This file tests SCHEMA semantics - constraints, triggers, foreign keys -
   * so it must reach them. As atl_app, an UPDATE on an append-only table is
   * refused at the PERMISSION layer (42501) before any trigger runs, and we
   * would never find out whether the trigger works.
   *
   * The complementary test - that the application role cannot do these things
   * at all - lives in roles.test.ts. Two roles, two files, two guarantees.
   */
  pool = createPool(config, logger, adminDatabaseUrl(config));
});

afterAll(async () => {
  await closePool(pool, logger);
});

/** A PostgreSQL error carries a SQLSTATE and, for constraint failures, its name. */
type DbError = Error & { code?: string; constraint?: string };

/** PostgreSQL SQLSTATEs we assert on, named so the tests read clearly. */
const SQLSTATE = {
  CHECK_VIOLATION: '23514',
  FOREIGN_KEY_VIOLATION: '23503',
  UNIQUE_VIOLATION: '23505',
  /** Our own: append-only table mutation attempted. */
  APPEND_ONLY: 'ATL01',
  /** Our own: illegal lifecycle transition. */
  ILLEGAL_TRANSITION: 'ATL02',
} as const;

/**
 * Run a test body inside a transaction that is always rolled back.
 * Perfect isolation, and no cleanup problem on append-only tables.
 */
async function withRollback(body: (client: pg.PoolClient) => Promise<void>): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await body(client);
  } finally {
    await client.query('ROLLBACK').catch(() => {
      /* already aborted; nothing to salvage */
    });
    client.release();
  }
}

/**
 * Attempt a statement expected to fail, and return the error for assertion.
 *
 * Wrapped in a SAVEPOINT because a failed statement aborts the whole
 * transaction in PostgreSQL - without this, the test could not run another
 * query afterwards. Returns null when the statement unexpectedly SUCCEEDS, so
 * a missing failure surfaces as a clear assertion error.
 */
async function captureError(
  client: pg.PoolClient,
  sql: string,
  params: unknown[] = [],
): Promise<DbError | null> {
  await client.query('SAVEPOINT probe');
  try {
    await client.query(sql, params);
    await client.query('RELEASE SAVEPOINT probe');
    return null;
  } catch (error) {
    await client.query('ROLLBACK TO SAVEPOINT probe');
    return error as DbError;
  }
}

/* ------------------------------------------------------------------------ */
/* Fixture builders - minimal valid rows, so each test changes one thing.   */
/* ------------------------------------------------------------------------ */

const SHA256_A = 'a'.repeat(64);

/**
 * Minimal valid rows, in a TEST-ONLY ID NAMESPACE (`*_test*`).
 *
 * Never reuse ids that seed data or production data might also use. An earlier
 * version of this file inserted 'mer_bigbasket' - which was fine until
 * `npm run seed` created that same merchant, at which point the insert hit a
 * unique violation, aborted the transaction, and 52 tests failed for a reason
 * that had nothing to do with what they were testing.
 *
 * Tests must not assume an empty database.
 */
async function seedBaseline(client: pg.PoolClient): Promise<void> {
  await client.query(
    `INSERT INTO merchants (id, legal_name, display_name, mcc, category)
     VALUES ('mer_test_shop', 'Test Grocery Supplies Pvt Ltd', 'Test Grocer', '5411', 'groceries')`,
  );
  await client.query(
    `INSERT INTO users (id, external_ref_hash, display_name)
     VALUES ('usr_test', $1, 'Test User')`,
    [SHA256_A],
  );
  await client.query(
    `INSERT INTO agents (id, display_name, vendor, agent_version)
     VALUES ('agt_test', 'Test Shopper', 'anthropic', '1.0.0')`,
  );
  await client.query(
    `INSERT INTO mandates (id, user_id, agent_id, label)
     VALUES ('mnd_test', 'usr_test', 'agt_test', 'Weekly groceries')`,
  );
}

/** A valid version row. Overrides let a test break exactly one field. */
async function insertVersion(
  client: pg.PoolClient,
  overrides: Record<string, unknown> = {},
): Promise<DbError | null> {
  const values: Record<string, unknown> = {
    mandate_id: 'mnd_test',
    version: 1,
    per_txn_limit_paise: 200000, // ₹2,000
    window_limit_paise: 500000, // ₹5,000
    window_kind: 'week',
    max_txn_per_hour: 5,
    valid_from: '2026-09-01T00:00:00Z',
    valid_to: '2026-12-31T23:59:59Z',
    created_by: 'test',
    // Required on every version since migration 0006. Supplying these by
    // default keeps each test focused on the one field it is breaking.
    consent_ref: 'consent_test_ref_0001',
    consent_at: '2026-09-01T08:55:00Z',
    ...overrides,
  };

  const columns = Object.keys(values);
  const placeholders = columns.map((_, index) => `$${index + 1}`);

  return captureError(
    client,
    `INSERT INTO mandate_versions (${columns.join(', ')}) VALUES (${placeholders.join(', ')})`,
    Object.values(values),
  );
}

/* ======================================================================== */
describe('mandate_versions is append-only', () => {
  it('accepts a new version (appending must still work)', async () => {
    await withRollback(async (client) => {
      await seedBaseline(client);

      expect(await insertVersion(client, { version: 1 })).toBeNull();
      expect(await insertVersion(client, { version: 2, per_txn_limit_paise: 500000 })).toBeNull();

      const { rows } = await client.query<{ count: number }>(
        `SELECT count(*)::bigint AS count FROM mandate_versions WHERE mandate_id = 'mnd_test'`,
      );
      expect(rows[0]?.count).toBe(2);
    });
  });

  it('REFUSES to UPDATE an existing version', async () => {
    // The central guarantee of Phase 2. If this ever passes, a past decision
    // can be silently re-justified against terms it never judged.
    await withRollback(async (client) => {
      await seedBaseline(client);
      await insertVersion(client);

      const error = await captureError(
        client,
        `UPDATE mandate_versions SET per_txn_limit_paise = 999999 WHERE mandate_id = 'mnd_test'`,
      );

      expect(error?.code).toBe(SQLSTATE.APPEND_ONLY);
      expect(error?.message).toMatch(/append-only/i);
    });
  });

  it('REFUSES to DELETE a version', async () => {
    await withRollback(async (client) => {
      await seedBaseline(client);
      await insertVersion(client);

      const error = await captureError(
        client,
        `DELETE FROM mandate_versions WHERE mandate_id = 'mnd_test'`,
      );

      expect(error?.code).toBe(SQLSTATE.APPEND_ONLY);
    });
  });

  it('REFUSES to TRUNCATE - three independent layers', async () => {
    // TRUNCATE does not fire row-level triggers, so the UPDATE/DELETE guard
    // above does not cover it. Without a statement-level trigger, one
    // TRUNCATE would erase every version silently.
    await withRollback(async (client) => {
      // Layer 1: a plain TRUNCATE is refused by the foreign key from
      // mandate_version_merchants, BEFORE any trigger runs.
      // 0A000 = feature_not_supported ("cannot truncate a table referenced in
      // a foreign key constraint"). Asserted explicitly, because an earlier
      // version of this test expected ATL01 here and would have "passed" for
      // the wrong reason had it not checked the code.
      const viaForeignKey = await captureError(client, `TRUNCATE mandate_versions`);
      expect(viaForeignKey?.code).toBe('0A000');

      // Layer 2: CASCADE gets past the foreign key, and then our
      // statement-level trigger stops it.
      const viaCascade = await captureError(client, `TRUNCATE mandate_versions CASCADE`);
      expect(viaCascade?.code).toBe(SQLSTATE.APPEND_ONLY);
      expect(viaCascade?.message).toMatch(/TRUNCATE is not permitted/i);

      // Layer 3: the leaf table has no inbound foreign key, so the trigger is
      // the ONLY thing standing between it and deletion.
      const leaf = await captureError(client, `TRUNCATE mandate_version_merchants`);
      expect(leaf?.code).toBe(SQLSTATE.APPEND_ONLY);
    });
  });

  it('keeps superseded terms readable - THE product guarantee', async () => {
    // A decision made against version 1 must remain explainable after the
    // user raises their limit. This test is the reason the whole two-table
    // split exists.
    await withRollback(async (client) => {
      await seedBaseline(client);
      await insertVersion(client, { version: 1, per_txn_limit_paise: 200000 });
      await insertVersion(client, { version: 2, per_txn_limit_paise: 500000 });

      const v1 = await client.query<{ per_txn_limit_paise: number }>(
        `SELECT per_txn_limit_paise FROM mandate_versions
         WHERE mandate_id = 'mnd_test' AND version = 1`,
      );
      // Still ₹2,000 - the old terms were not rewritten by the new ones.
      expect(v1.rows[0]?.per_txn_limit_paise).toBe(200000);

      // And "current" is derived, not stored, so it cannot drift.
      const current = await client.query<{ version: number }>(
        `SELECT version FROM mandate_versions
         WHERE mandate_id = 'mnd_test' ORDER BY version DESC LIMIT 1`,
      );
      expect(current.rows[0]?.version).toBe(2);
    });
  });
});

/* ======================================================================== */
describe('mandate lifecycle', () => {
  it('allows active -> revoked when fully recorded', async () => {
    await withRollback(async (client) => {
      await seedBaseline(client);

      const error = await captureError(
        client,
        `UPDATE mandates
            SET status = 'revoked', revoked_at = now(),
                revoked_by = 'usr_test', revoked_reason = 'user withdrew consent'
          WHERE id = 'mnd_test'`,
      );

      expect(error).toBeNull();
    });
  });

  it('REFUSES revoked -> active (revocation is terminal)', async () => {
    // Reviving a revoked mandate would make its audit trail ambiguous about
    // which period was actually authorised. Resuming delegation is a NEW
    // mandate, not a state change.
    await withRollback(async (client) => {
      await seedBaseline(client);
      await client.query(
        `UPDATE mandates SET status='revoked', revoked_at=now(),
                revoked_by='usr_test', revoked_reason='test'
          WHERE id='mnd_test'`,
      );

      const error = await captureError(
        client,
        `UPDATE mandates SET status='active', revoked_at=NULL,
                revoked_by=NULL, revoked_reason=NULL
          WHERE id='mnd_test'`,
      );

      expect(error?.code).toBe(SQLSTATE.ILLEGAL_TRANSITION);
      expect(error?.message).toMatch(/terminal/i);
    });
  });

  it('REFUSES to re-attribute a mandate to a different user', async () => {
    // Otherwise a mandate's entire audit history could be silently moved to
    // another person.
    await withRollback(async (client) => {
      await seedBaseline(client);
      await client.query(
        `INSERT INTO users (id, external_ref_hash, display_name)
         VALUES ('usr_other', $1, 'Other')`,
        ['b'.repeat(64)],
      );

      const error = await captureError(
        client,
        `UPDATE mandates SET user_id='usr_other' WHERE id='mnd_test'`,
      );

      expect(error?.code).toBe(SQLSTATE.ILLEGAL_TRANSITION);
      expect(error?.message).toMatch(/immutable/i);
    });
  });

  it('REFUSES a revocation missing its reason', async () => {
    await withRollback(async (client) => {
      await seedBaseline(client);

      const error = await captureError(
        client,
        `UPDATE mandates SET status='revoked', revoked_at=now(), revoked_by='usr_test'
          WHERE id='mnd_test'`,
      );

      expect(error?.code).toBe(SQLSTATE.CHECK_VIOLATION);
      expect(error?.constraint).toBe('mandates_revocation_complete');
    });
  });

  it('REFUSES revocation fields on a still-active mandate', async () => {
    await withRollback(async (client) => {
      await seedBaseline(client);

      const error = await captureError(
        client,
        `UPDATE mandates SET revoked_reason='sneaky' WHERE id='mnd_test'`,
      );

      expect(error?.code).toBe(SQLSTATE.CHECK_VIOLATION);
      expect(error?.constraint).toBe('mandates_revocation_fields_only_when_revoked');
    });
  });
});

/* ======================================================================== */
describe('mandate terms cannot be incoherent', () => {
  it('REFUSES a per-transaction limit above the window limit', async () => {
    // Incoherent: the second transaction could never succeed. Rejecting it
    // here means the policy engine never has to reason about a contradiction.
    await withRollback(async (client) => {
      await seedBaseline(client);

      const error = await insertVersion(client, {
        per_txn_limit_paise: 900000,
        window_limit_paise: 500000,
      });

      expect(error?.code).toBe(SQLSTATE.CHECK_VIOLATION);
      expect(error?.constraint).toBe('mandate_versions_per_txn_within_window');
    });
  });

  it('REFUSES a zero or negative limit', async () => {
    await withRollback(async (client) => {
      await seedBaseline(client);

      const zero = await insertVersion(client, { per_txn_limit_paise: 0 });
      expect(zero?.constraint).toBe('mandate_versions_per_txn_limit_positive');

      const negative = await insertVersion(client, { per_txn_limit_paise: -100 });
      expect(negative?.constraint).toBe('mandate_versions_per_txn_limit_positive');
    });
  });

  it('REFUSES a non-MCC value inside blocked_mccs (domain check per element)', async () => {
    // MCC-based blocking is only meaningful if every entry really is an MCC.
    // 'alcohol' as a category string would match nothing and silently block
    // nothing.
    await withRollback(async (client) => {
      await seedBaseline(client);

      const error = await insertVersion(client, { blocked_mccs: ['5921', 'alcohol'] });

      expect(error?.code).toBe(SQLSTATE.CHECK_VIOLATION);
      expect(error?.constraint).toBe('mcc_code_is_four_digits');
    });
  });

  it('accepts a valid blocked-MCC list', async () => {
    await withRollback(async (client) => {
      await seedBaseline(client);
      // 5921 liquor, 7995 gambling, 5993 tobacco
      expect(await insertVersion(client, { blocked_mccs: ['5921', '7995', '5993'] })).toBeNull();
    });
  });

  it('REFUSES a misspelled weekday', async () => {
    // A typo would silently narrow the permitted window instead of erroring.
    await withRollback(async (client) => {
      await seedBaseline(client);

      const error = await insertVersion(client, { allowed_weekdays: ['MON', 'FUNDAY'] });

      expect(error?.code).toBe(SQLSTATE.CHECK_VIOLATION);
      expect(error?.constraint).toBe('mandate_versions_weekdays_valid');
    });
  });

  it('REFUSES an empty weekday list', async () => {
    // An empty list is not "any day"; it is a mandate that can never fire.
    await withRollback(async (client) => {
      await seedBaseline(client);
      const error = await insertVersion(client, { allowed_weekdays: [] });
      expect(error?.constraint).toBe('mandate_versions_weekdays_valid');
    });
  });

  it('REFUSES an unknown payment method', async () => {
    await withRollback(async (client) => {
      await seedBaseline(client);
      const error = await insertVersion(client, { payment_methods: ['crypto'] });
      expect(error?.constraint).toBe('mandate_versions_payment_methods_valid');
    });
  });

  it('REFUSES validity that ends before it starts', async () => {
    await withRollback(async (client) => {
      await seedBaseline(client);

      const error = await insertVersion(client, {
        valid_from: '2026-12-01T00:00:00Z',
        valid_to: '2026-09-01T00:00:00Z',
      });

      expect(error?.constraint).toBe('mandate_versions_validity_ordered');
    });
  });

  it('REFUSES a time window that ends before it starts', async () => {
    await withRollback(async (client) => {
      await seedBaseline(client);
      const error = await insertVersion(client, { window_start_hour: 20, window_end_hour: 8 });
      expect(error?.constraint).toBe('mandate_versions_window_hours_valid');
    });
  });

  it('REFUSES a signature without the key that produced it', async () => {
    // An unverifiable signature is worse than none: it looks like evidence.
    await withRollback(async (client) => {
      await seedBaseline(client);
      const error = await insertVersion(client, { signature: 'sig_abc' });
      expect(error?.constraint).toBe('mandate_versions_signature_complete');
    });
  });

  it('REFUSES a version with no consent reference', async () => {
    // Every version requires recorded consent, including version 1. There is
    // no code path that can skip this, because NOT NULL involves no code.
    await withRollback(async (client) => {
      await seedBaseline(client);

      const error = await captureError(
        client,
        `INSERT INTO mandate_versions
           (mandate_id, version, per_txn_limit_paise, window_limit_paise, window_kind,
            max_txn_per_hour, valid_from, valid_to, created_by, consent_at)
         VALUES ('mnd_test', 1, 200000, 500000, 'week', 5,
                 '2026-09-01T00:00:00Z', '2026-12-31T23:59:59Z', 'test',
                 '2026-09-01T08:55:00Z')`,
      );

      // 23502 = not_null_violation
      expect(error?.code).toBe('23502');
    });
  });

  it('REFUSES a blank consent reference', async () => {
    // An empty string satisfies NOT NULL while meaning nothing.
    await withRollback(async (client) => {
      await seedBaseline(client);

      const error = await insertVersion(client, { consent_ref: '   ' });
      expect(error?.constraint).toBe('mandate_versions_consent_ref_not_blank');
    });
  });

  it('REFUSES consent dated after the change it authorises', async () => {
    // "We have consent" dated next year is not consent for this change.
    await withRollback(async (client) => {
      await seedBaseline(client);

      const error = await insertVersion(client, { consent_at: '2027-01-01T00:00:00Z' });
      expect(error?.constraint).toBe('mandate_versions_consent_not_after_creation');
    });
  });

  it('REFUSES a duplicate version number for the same mandate', async () => {
    // Concurrent attempts to create "the next version" collide here, which
    // fails loudly instead of corrupting the sequence.
    await withRollback(async (client) => {
      await seedBaseline(client);
      await insertVersion(client, { version: 1 });

      const error = await insertVersion(client, { version: 1 });
      expect(error?.code).toBe(SQLSTATE.UNIQUE_VIOLATION);
    });
  });
});

/* ======================================================================== */
describe('merchant allowlist integrity', () => {
  it('accepts an allowlist entry for a real merchant and version', async () => {
    await withRollback(async (client) => {
      await seedBaseline(client);
      await insertVersion(client);

      const error = await captureError(
        client,
        `INSERT INTO mandate_version_merchants (mandate_id, version, merchant_id)
         VALUES ('mnd_test', 1, 'mer_test_shop')`,
      );

      expect(error).toBeNull();
    });
  });

  it('REFUSES allowlisting a merchant that does not exist', async () => {
    // THE reason this is a join table rather than a TEXT[]. In an array, a
    // typo becomes a permanent silent BLOCK: the agent is refused forever and
    // the verdict reads as correct behaviour ("merchant not in allowlist"),
    // with nothing indicating the allowlist itself is wrong.
    await withRollback(async (client) => {
      await seedBaseline(client);
      await insertVersion(client);

      const error = await captureError(
        client,
        `INSERT INTO mandate_version_merchants (mandate_id, version, merchant_id)
         VALUES ('mnd_test', 1, 'mer_bigbaskt')`, // typo
      );

      expect(error?.code).toBe(SQLSTATE.FOREIGN_KEY_VIOLATION);
    });
  });

  it('REFUSES an allowlist entry for a version that does not exist', async () => {
    await withRollback(async (client) => {
      await seedBaseline(client);
      await insertVersion(client, { version: 1 });

      const error = await captureError(
        client,
        `INSERT INTO mandate_version_merchants (mandate_id, version, merchant_id)
         VALUES ('mnd_test', 99, 'mer_test_shop')`,
      );

      expect(error?.code).toBe(SQLSTATE.FOREIGN_KEY_VIOLATION);
    });
  });

  it('is append-only', async () => {
    await withRollback(async (client) => {
      await seedBaseline(client);
      await insertVersion(client);
      await client.query(
        `INSERT INTO mandate_version_merchants (mandate_id, version, merchant_id)
         VALUES ('mnd_test', 1, 'mer_test_shop')`,
      );

      const updated = await captureError(
        client,
        `UPDATE mandate_version_merchants SET merchant_id='mer_test_shop' WHERE mandate_id='mnd_test'`,
      );
      expect(updated?.code).toBe(SQLSTATE.APPEND_ONLY);

      const deleted = await captureError(
        client,
        `DELETE FROM mandate_version_merchants WHERE mandate_id='mnd_test'`,
      );
      expect(deleted?.code).toBe(SQLSTATE.APPEND_ONLY);
    });
  });

  it('REFUSES deleting a merchant that a mandate still allowlists', async () => {
    // ON DELETE RESTRICT. Removing the merchant would orphan the terms a past
    // decision was judged against.
    await withRollback(async (client) => {
      await seedBaseline(client);
      await insertVersion(client);
      await client.query(
        `INSERT INTO mandate_version_merchants (mandate_id, version, merchant_id)
         VALUES ('mnd_test', 1, 'mer_test_shop')`,
      );

      const error = await captureError(client, `DELETE FROM merchants WHERE id='mer_test_shop'`);
      expect(error?.code).toBe(SQLSTATE.FOREIGN_KEY_VIOLATION);
    });
  });
});

/* ------------------------------------------------------------------------ */
/* Fixtures for the authorization chain: request -> decision -> payment.    */
/* ------------------------------------------------------------------------ */

/** Baseline + version 1 + allowlist. Returns nothing; ids are fixed. */
async function seedThroughVersion(client: pg.PoolClient): Promise<void> {
  await seedBaseline(client);
  await insertVersion(client, { version: 1 });
  await client.query(
    `INSERT INTO mandate_version_merchants (mandate_id, version, merchant_id)
     VALUES ('mnd_test', 1, 'mer_test_shop')`,
  );
}

async function insertRequest(
  client: pg.PoolClient,
  overrides: Record<string, unknown> = {},
): Promise<DbError | null> {
  const values: Record<string, unknown> = {
    id: 'authz_test',
    mandate_id: 'mnd_test',
    mandate_version: 1,
    agent_id: 'agt_test',
    signature_verified: true,
    merchant_id: 'mer_test_shop',
    amount_paise: 124000, // ₹1,240
    payment_method: 'upi_reserve_pay',
    idempotency_key: 'idem_test_000001',
    request_id: 'req_00000001',
    ...overrides,
  };
  const columns = Object.keys(values);
  return captureError(
    client,
    `INSERT INTO authorization_requests (${columns.join(', ')})
     VALUES (${columns.map((_, i) => `$${i + 1}`).join(', ')})`,
    Object.values(values),
  );
}

async function insertDecision(
  client: pg.PoolClient,
  overrides: Record<string, unknown> = {},
): Promise<DbError | null> {
  const values: Record<string, unknown> = {
    id: 'dec_test',
    authorization_request_id: 'authz_test',
    mandate_id: 'mnd_test',
    mandate_version: 1,
    verdict: 'PASS',
    reason: 'Requested ₹1,240 is within the ₹2,000 per-transaction limit.',
    engine_version: 'engine-v1',
    spend_window_start: '2026-09-01T00:00:00Z',
    spend_window_end: '2026-09-08T00:00:00Z',
    spent_before_paise: 0,
    ...overrides,
  };
  const columns = Object.keys(values);
  return captureError(
    client,
    `INSERT INTO decisions (${columns.join(', ')})
     VALUES (${columns.map((_, i) => `$${i + 1}`).join(', ')})`,
    Object.values(values),
  );
}

async function insertPayment(
  client: pg.PoolClient,
  overrides: Record<string, unknown> = {},
): Promise<DbError | null> {
  const values: Record<string, unknown> = {
    id: 'pay_test',
    decision_id: 'dec_test',
    mandate_id: 'mnd_test',
    voucher_jti: 'vch_0123456789abcdef',
    amount_paise: 124000,
    provider: 'mock_upi',
    ...overrides,
  };
  const columns = Object.keys(values);
  return captureError(
    client,
    `INSERT INTO payments (${columns.join(', ')})
     VALUES (${columns.map((_, i) => `$${i + 1}`).join(', ')})`,
    Object.values(values),
  );
}

/* ======================================================================== */
describe('idempotency prevents a retry becoming a second charge', () => {
  it('REFUSES a duplicate idempotency key for the same agent', async () => {
    // A network retry must not create a second authorization. This UNIQUE
    // constraint - not application logic - is what guarantees it.
    await withRollback(async (client) => {
      await seedThroughVersion(client);
      expect(await insertRequest(client, { id: 'authz_one' })).toBeNull();

      const error = await insertRequest(client, { id: 'authz_two' });

      expect(error?.code).toBe(SQLSTATE.UNIQUE_VIOLATION);
      expect(error?.constraint).toBe('authorization_requests_idempotent_per_agent');
    });
  });

  it('ALLOWS the same key from a different agent', async () => {
    // Idempotency is scoped per agent: two agents may legitimately pick the
    // same key, and one must not be able to squat another's key space.
    await withRollback(async (client) => {
      await seedThroughVersion(client);
      await client.query(
        `INSERT INTO agents (id, display_name, vendor, agent_version)
         VALUES ('agt_other', 'Other', 'openai', '1.0.0')`,
      );
      await insertRequest(client, { id: 'authz_one' });

      const error = await insertRequest(client, { id: 'authz_two', agent_id: 'agt_other' });
      expect(error).toBeNull();
    });
  });

  it('records a request whose signature FAILED', async () => {
    // A rejected-signature attempt is exactly what a security review counts.
    // It must be storable, not discarded.
    await withRollback(async (client) => {
      await seedThroughVersion(client);
      expect(await insertRequest(client, { signature_verified: false })).toBeNull();
    });
  });
});

/* ======================================================================== */
describe('decisions', () => {
  it('REFUSES a second decision for the same request', async () => {
    // Two decisions for one request would make "what did we decide?"
    // ambiguous, which is unanswerable in a dispute.
    await withRollback(async (client) => {
      await seedThroughVersion(client);
      await insertRequest(client);
      await insertDecision(client);

      const error = await insertDecision(client, { id: 'dec_second' });
      expect(error?.code).toBe(SQLSTATE.UNIQUE_VIOLATION);
    });
  });

  it('REFUSES an unknown verdict', async () => {
    await withRollback(async (client) => {
      await seedThroughVersion(client);
      await insertRequest(client);

      const error = await insertDecision(client, { verdict: 'MAYBE' });
      expect(error?.constraint).toBe('decisions_verdict_valid');
    });
  });

  it('REFUSES a risk score without its provider', async () => {
    // A score with no provider cannot be interpreted or re-checked later.
    await withRollback(async (client) => {
      await seedThroughVersion(client);
      await insertRequest(client);

      const error = await insertDecision(client, { risk_score: 42 });
      expect(error?.constraint).toBe('decisions_risk_complete');
    });
  });

  it('distinguishes "no risk signal" from "score 0"', async () => {
    await withRollback(async (client) => {
      await seedThroughVersion(client);
      await insertRequest(client);
      expect(await insertDecision(client, { risk_score: 0, risk_provider: 'mock' })).toBeNull();

      const { rows } = await client.query<{ risk_score: number | null }>(
        `SELECT risk_score FROM decisions WHERE id = 'dec_test'`,
      );
      expect(rows[0]?.risk_score).toBe(0); // not null, and not conflated with absence
    });
  });

  it('is append-only', async () => {
    await withRollback(async (client) => {
      await seedThroughVersion(client);
      await insertRequest(client);
      await insertDecision(client);

      const updated = await captureError(
        client,
        `UPDATE decisions SET verdict='PASS' WHERE id='dec_test'`,
      );
      expect(updated?.code).toBe(SQLSTATE.APPEND_ONLY);
    });
  });
});

/* ======================================================================== */
describe('rule_evaluations are the explainability record', () => {
  async function insertRule(
    client: pg.PoolClient,
    overrides: Record<string, unknown> = {},
  ): Promise<DbError | null> {
    const values: Record<string, unknown> = {
      decision_id: 'dec_test',
      rule_code: 'MANDATE_PER_TXN_LIMIT',
      sequence: 1,
      verdict: 'PASS',
      signal: 'requested 124000 paise',
      expected: '<= 200000 paise',
      actual: '124000 paise',
      reason: 'Requested ₹1,240 is within the ₹2,000 per-transaction limit.',
      observed_paise: 124000,
      limit_paise: 200000,
      ...overrides,
    };
    const columns = Object.keys(values);
    return captureError(
      client,
      `INSERT INTO rule_evaluations (${columns.join(', ')})
       VALUES (${columns.map((_, i) => `$${i + 1}`).join(', ')})`,
      Object.values(values),
    );
  }

  it('records passing rules too, so we can prove a check ran', async () => {
    // Recording only failures leaves us unable to demonstrate that a check
    // was performed at all - which is precisely what an auditor asks.
    await withRollback(async (client) => {
      await seedThroughVersion(client);
      await insertRequest(client);
      await insertDecision(client);

      expect(await insertRule(client, { rule_code: 'MANDATE_PER_TXN_LIMIT' })).toBeNull();
      expect(await insertRule(client, { rule_code: 'MERCHANT_ALLOWLIST', sequence: 2 })).toBeNull();
      expect(await insertRule(client, { rule_code: 'MANDATE_EXPIRY', sequence: 3 })).toBeNull();
    });
  });

  it('allows SKIP as a real outcome', async () => {
    // A velocity rule cannot run if the mandate sets no velocity limit, and
    // silence would be indistinguishable from a pass.
    await withRollback(async (client) => {
      await seedThroughVersion(client);
      await insertRequest(client);
      await insertDecision(client);

      expect(
        await insertRule(client, {
          rule_code: 'VELOCITY_LIMIT',
          verdict: 'SKIP',
          observed_paise: null,
          limit_paise: null,
        }),
      ).toBeNull();
    });
  });

  it('keeps machine-readable amounts so a report need not parse English', async () => {
    await withRollback(async (client) => {
      await seedThroughVersion(client);
      await insertRequest(client);
      await insertDecision(client);
      await insertRule(client, { observed_paise: 620000, limit_paise: 200000, verdict: 'BLOCK' });

      // "breached by ₹4,200" computed in SQL, not scraped from a sentence.
      const { rows } = await client.query<{ breach_paise: number }>(
        `SELECT observed_paise - limit_paise AS breach_paise
           FROM rule_evaluations WHERE decision_id = 'dec_test'`,
      );
      expect(rows[0]?.breach_paise).toBe(420000);
    });
  });

  it('REFUSES a lowercase rule code', async () => {
    // Rule codes are grouped in reports; inconsistent casing splits a group
    // in two and quietly halves a count.
    await withRollback(async (client) => {
      await seedThroughVersion(client);
      await insertRequest(client);
      await insertDecision(client);

      const error = await insertRule(client, { rule_code: 'mandate_per_txn_limit' });
      expect(error?.constraint).toBe('rule_evaluations_rule_code_format');
    });
  });

  it('REFUSES the same rule twice for one decision', async () => {
    await withRollback(async (client) => {
      await seedThroughVersion(client);
      await insertRequest(client);
      await insertDecision(client);
      await insertRule(client);

      const error = await insertRule(client, { sequence: 2 });
      expect(error?.code).toBe(SQLSTATE.UNIQUE_VIOLATION);
    });
  });
});

/* ======================================================================== */
describe('risk signals are structurally advisory', () => {
  it('REFUSES a signal marked non-advisory', async () => {
    // Risk can raise a FLAG; it can never override a BLOCK or create a PASS.
    // Making risk authoritative should require a migration and a review, not
    // one line in a service.
    await withRollback(async (client) => {
      await seedThroughVersion(client);
      await insertRequest(client);

      const error = await captureError(
        client,
        `INSERT INTO risk_signals (id, authorization_request_id, provider, score, band, is_advisory)
         VALUES ('rsk_test', 'authz_test', 'mock', 90, 'HIGH', false)`,
      );

      expect(error?.constraint).toBe('risk_signals_always_advisory');
    });
  });

  it('accepts an advisory signal with reasons', async () => {
    await withRollback(async (client) => {
      await seedThroughVersion(client);
      await insertRequest(client);

      const error = await captureError(
        client,
        `INSERT INTO risk_signals (id, authorization_request_id, provider, score, band, reasons, latency_ms)
         VALUES ('rsk_test', 'authz_test', 'mock', 12, 'LOW',
                 ARRAY['no prior disputes','amount within historical range'], 4)`,
      );

      expect(error).toBeNull();
    });
  });
});

/* ======================================================================== */
describe('payments: the voucher is single-use BY CONSTRAINT', () => {
  it('accepts the first capture of a voucher', async () => {
    await withRollback(async (client) => {
      await seedThroughVersion(client);
      await insertRequest(client);
      await insertDecision(client);

      expect(await insertPayment(client)).toBeNull();
    });
  });

  it('REFUSES replaying the same voucher jti', async () => {
    // THE security guarantee. Even if an attacker captures a valid voucher and
    // replays it within its 60-second lifetime, and even if two captures race
    // perfectly, the unique index means only one row can exist.
    //
    // Application-level "have we seen this jti?" logic loses that race.
    // A unique index does not.
    await withRollback(async (client) => {
      await seedThroughVersion(client);
      await insertRequest(client);
      await insertDecision(client);
      await insertPayment(client, { id: 'pay_first' });

      // A different decision, deliberately - proving the jti alone blocks it.
      await insertRequest(client, { id: 'authz_2', idempotency_key: 'idem_test_000002' });
      await insertDecision(client, { id: 'dec_2', authorization_request_id: 'authz_2' });

      const error = await insertPayment(client, {
        id: 'pay_replay',
        decision_id: 'dec_2',
        voucher_jti: 'vch_0123456789abcdef', // same voucher
      });

      expect(error?.code).toBe(SQLSTATE.UNIQUE_VIOLATION);
      expect(error?.constraint).toBe('payments_voucher_jti_key');
    });
  });

  it('REFUSES two payments for one decision', async () => {
    await withRollback(async (client) => {
      await seedThroughVersion(client);
      await insertRequest(client);
      await insertDecision(client);
      await insertPayment(client, { id: 'pay_first' });

      const error = await insertPayment(client, {
        id: 'pay_second',
        voucher_jti: 'vch_fedcba9876543210',
      });

      expect(error?.code).toBe(SQLSTATE.UNIQUE_VIOLATION);
    });
  });
});

/* ======================================================================== */
describe('payment state machine is enforced by the database', () => {
  async function seedPayment(client: pg.PoolClient): Promise<void> {
    await seedThroughVersion(client);
    await insertRequest(client);
    await insertDecision(client);
    await insertPayment(client);
  }

  it('allows the legal path created -> authorized -> captured', async () => {
    await withRollback(async (client) => {
      await seedPayment(client);

      expect(
        await captureError(
          client,
          `UPDATE payments SET status='authorized', authorized_at=now() WHERE id='pay_test'`,
        ),
      ).toBeNull();

      expect(
        await captureError(
          client,
          `UPDATE payments SET status='captured', captured_at=now() WHERE id='pay_test'`,
        ),
      ).toBeNull();
    });
  });

  it('REFUSES skipping authorization (created -> captured)', async () => {
    await withRollback(async (client) => {
      await seedPayment(client);

      const error = await captureError(
        client,
        `UPDATE payments SET status='captured', captured_at=now() WHERE id='pay_test'`,
      );

      expect(error?.code).toBe(SQLSTATE.ILLEGAL_TRANSITION);
      expect(error?.message).toMatch(/illegal payment transition: created -> captured/);
    });
  });

  it('REFUSES going backwards from captured', async () => {
    // A record that says money moved must never be able to say it did not.
    await withRollback(async (client) => {
      await seedPayment(client);
      await client.query(
        `UPDATE payments SET status='authorized', authorized_at=now() WHERE id='pay_test'`,
      );
      await client.query(
        `UPDATE payments SET status='captured', captured_at=now() WHERE id='pay_test'`,
      );

      const error = await captureError(
        client,
        `UPDATE payments SET status='created' WHERE id='pay_test'`,
      );
      expect(error?.code).toBe(SQLSTATE.ILLEGAL_TRANSITION);
    });
  });

  it('treats failed as terminal', async () => {
    await withRollback(async (client) => {
      await seedPayment(client);
      await client.query(
        `UPDATE payments SET status='failed', failed_at=now(),
                failure_code='insufficient_funds', failure_reason='payer balance too low'
          WHERE id='pay_test'`,
      );

      const error = await captureError(
        client,
        `UPDATE payments SET status='authorized', authorized_at=now() WHERE id='pay_test'`,
      );
      expect(error?.code).toBe(SQLSTATE.ILLEGAL_TRANSITION);
    });
  });

  it('REFUSES a failure with no explanation', async () => {
    // "It failed" is not a reconcilable record.
    await withRollback(async (client) => {
      await seedPayment(client);

      const error = await captureError(
        client,
        `UPDATE payments SET status='failed', failed_at=now() WHERE id='pay_test'`,
      );
      expect(error?.constraint).toBe('payments_failure_explained');
    });
  });

  it('REFUSES a captured payment with no captured_at', async () => {
    await withRollback(async (client) => {
      await seedPayment(client);
      await client.query(
        `UPDATE payments SET status='authorized', authorized_at=now() WHERE id='pay_test'`,
      );

      const error = await captureError(
        client,
        `UPDATE payments SET status='captured' WHERE id='pay_test'`,
      );
      expect(error?.constraint).toBe('payments_captured_timestamped');
    });
  });

  it('REFUSES changing the amount or the voucher after creation', async () => {
    // Otherwise a captured payment could claim a different authorisation than
    // the one that actually permitted it.
    await withRollback(async (client) => {
      await seedPayment(client);

      const amount = await captureError(
        client,
        `UPDATE payments SET amount_paise=999999 WHERE id='pay_test'`,
      );
      expect(amount?.code).toBe(SQLSTATE.ILLEGAL_TRANSITION);
      expect(amount?.message).toMatch(/immutable/i);

      const voucher = await captureError(
        client,
        `UPDATE payments SET voucher_jti='vch_aaaaaaaaaaaaaaaa' WHERE id='pay_test'`,
      );
      expect(voucher?.code).toBe(SQLSTATE.ILLEGAL_TRANSITION);
    });
  });

  it('labels simulated settlements honestly in the data', async () => {
    // 'mock_upi' is on the row, so no report can accidentally present a
    // simulated settlement as a real one.
    await withRollback(async (client) => {
      await seedPayment(client);
      const { rows } = await client.query<{ provider: string }>(
        `SELECT provider FROM payments WHERE id='pay_test'`,
      );
      expect(rows[0]?.provider).toBe('mock_upi');

      const bogus = await insertPayment(client, {
        id: 'pay_bogus',
        decision_id: 'dec_test',
        provider: 'npci_production',
      });
      expect(bogus?.constraint).toBe('payments_provider_valid');
    });
  });
});

/* ======================================================================== */
describe('money columns round-trip exactly', () => {
  it('stores and returns paise as an exact integer', async () => {
    await withRollback(async (client) => {
      await seedBaseline(client);
      await insertVersion(client, { per_txn_limit_paise: 487050 });

      const { rows } = await client.query<{ per_txn_limit_paise: number }>(
        `SELECT per_txn_limit_paise FROM mandate_versions WHERE mandate_id='mnd_test'`,
      );

      // A number, not a string: our int8 parser is registered.
      expect(typeof rows[0]?.per_txn_limit_paise).toBe('number');
      expect(rows[0]?.per_txn_limit_paise).toBe(487050);
    });
  });
});
