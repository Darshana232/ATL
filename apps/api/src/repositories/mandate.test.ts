/**
 * Mandate repository. Integration tests against the real database, because
 * the thing under test is the SQL.
 *
 * Isolation by transaction rollback, and fixtures in a `*_test*` id namespace
 * so they cannot collide with seed data (PHASE_02 mistake 7).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type pg from 'pg';
import { adminDatabaseUrl, loadConfig, type Config } from '../config.js';
import { createLogger } from '../logger.js';
import { closePool, createPool, type Pool } from '../db/pool.js';
import { createMandateTerms, type MandateTerms } from '../domain/mandate.js';
import {
  insertMandate,
  insertVersion,
  listVersions,
  loadForAuthorization,
  loadVersion,
  newMandateId,
  nextVersionNumber,
  revokeMandate,
} from './mandate.js';

const config: Config = loadConfig({ ...process.env, NODE_ENV: 'test', LOG_LEVEL: 'fatal' });
const logger = createLogger(config);

let pool: Pool;

beforeAll(() => {
  pool = createPool(config, logger, adminDatabaseUrl(config));
});

afterAll(async () => {
  await closePool(pool, logger);
});

async function withRollback(body: (client: pg.PoolClient) => Promise<void>): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await body(client);
  } finally {
    await client.query('ROLLBACK').catch(() => {});
    client.release();
  }
}

const MANDATE_ID = 'mnd_test_repo';

function terms(overrides: Record<string, unknown> = {}): MandateTerms {
  return createMandateTerms({
    perTxnLimitPaise: 200_000,
    windowLimitPaise: 500_000,
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
    ...overrides,
  });
}

/** Fixtures in a test-only id namespace. */
async function seedFixtures(client: pg.PoolClient): Promise<void> {
  await client.query(
    `INSERT INTO merchants (id, legal_name, display_name, mcc, category) VALUES
       ('mer_test_shop','Test Grocery Pvt Ltd','Test Grocer','5411','groceries'),
       ('mer_test_two','Second Test Pvt Ltd','Second Shop','5411','groceries')`,
  );
  await client.query(
    `INSERT INTO users (id, external_ref_hash, display_name) VALUES ('usr_test_repo',$1,'Repo User')`,
    ['a'.repeat(64)],
  );
  await client.query(
    `INSERT INTO agents (id, display_name, vendor, agent_version)
     VALUES ('agt_test_repo','Repo Agent','anthropic','1.0.0')`,
  );
}

async function createBaseMandate(
  client: pg.PoolClient,
  merchantIds: readonly string[] = ['mer_test_shop'],
): Promise<void> {
  await insertMandate(client, {
    mandateId: MANDATE_ID,
    userId: 'usr_test_repo',
    agentId: 'agt_test_repo',
    label: 'Repo test mandate',
    terms: terms({ perTxnLimitPaise: 150_000, windowLimitPaise: 400_000 }),
    merchantIds,
    createdBy: 'test',
    changeReason: 'initial mandate',
    consentRef: 'consent_test_v1',
    consentAt: new Date('2026-09-01T08:55:00Z'),
  });
}

describe('loadForAuthorization', () => {
  it('returns the mandate, its current version and its allowlist', async () => {
    await withRollback(async (client) => {
      await seedFixtures(client);
      await createBaseMandate(client, ['mer_test_shop', 'mer_test_two']);

      const loaded = await loadForAuthorization(client, MANDATE_ID);

      expect(loaded).not.toBeNull();
      expect(loaded?.mandate.id).toBe(MANDATE_ID);
      expect(loaded?.mandate.userId).toBe('usr_test_repo');
      expect(loaded?.mandate.status).toBe('active');
      expect(loaded?.version.version).toBe(1);
      // array_agg is ordered, so the allowlist is deterministic.
      expect(loaded?.version.merchantAllowlist).toEqual(['mer_test_shop', 'mer_test_two']);
    });
  });

  it('issues EXACTLY ONE query - this runs on every authorization', async () => {
    // Three round trips (mandate, then latest version, then allowlist) would
    // be an N+1 on the hottest path in the system. JOIN LATERAL is what makes
    // one query possible: the subquery can reference m.id from the row to its
    // left, which a plain subquery cannot.
    await withRollback(async (client) => {
      await seedFixtures(client);
      await createBaseMandate(client);

      let queryCount = 0;
      const counting = {
        query: (...args: unknown[]) => {
          queryCount += 1;
          return (client.query as (...a: unknown[]) => unknown)(...args);
        },
      } as unknown as pg.PoolClient;

      await loadForAuthorization(counting, MANDATE_ID);

      expect(queryCount).toBe(1);
    });
  });

  it('returns the CURRENT version after later versions are added', async () => {
    await withRollback(async (client) => {
      await seedFixtures(client);
      await createBaseMandate(client);

      await insertVersion(client, {
        mandateId: MANDATE_ID,
        version: 2,
        terms: terms({ perTxnLimitPaise: 200_000 }),
        merchantIds: ['mer_test_shop'],
        createdBy: 'test',
        changeReason: 'raised limit',
        consentRef: 'consent_test_v2',
        consentAt: new Date('2026-09-02T10:00:00Z'),
      });
      await insertVersion(client, {
        mandateId: MANDATE_ID,
        version: 3,
        terms: terms({ perTxnLimitPaise: 250_000 }),
        merchantIds: ['mer_test_shop'],
        createdBy: 'test',
        changeReason: 'raised again',
        consentRef: 'consent_test_v3',
        consentAt: new Date('2026-09-03T10:00:00Z'),
      });

      const loaded = await loadForAuthorization(client, MANDATE_ID);

      expect(loaded?.version.version).toBe(3);
      expect(loaded?.version.terms.perTxnLimitPaise).toBe(250_000);
    });
  });

  it('loads an EMPTY allowlist as [], never null', async () => {
    // Deny by default. If an empty allowlist arrived as null, and null were
    // later read as "unset" and then as "all merchants", a deny-by-default
    // rule would silently invert into allow-by-default.
    await withRollback(async (client) => {
      await seedFixtures(client);
      await createBaseMandate(client, []);

      const loaded = await loadForAuthorization(client, MANDATE_ID);

      expect(loaded?.version.merchantAllowlist).toEqual([]);
      expect(loaded?.version.merchantAllowlist).not.toBeNull();
    });
  });

  it('returns null for a mandate that does not exist', async () => {
    await withRollback(async (client) => {
      expect(await loadForAuthorization(client, 'mnd_test_missing')).toBeNull();
    });
  });

  it('reports the MANDATE createdAt, not the version createdAt', async () => {
    // Both tables have created_at; without the alias the version's value would
    // silently win and the mandate would appear to have been created whenever
    // its newest version was.
    await withRollback(async (client) => {
      await seedFixtures(client);
      await createBaseMandate(client);

      const loaded = await loadForAuthorization(client, MANDATE_ID);
      const { rows } = await client.query<{ created_at: Date }>(
        `SELECT created_at FROM mandates WHERE id = $1`,
        [MANDATE_ID],
      );

      expect(loaded?.mandate.createdAt.getTime()).toBe(rows[0]?.created_at.getTime());
    });
  });
});

describe('loadVersion - the read the two-table design exists for', () => {
  it('returns a superseded version with its ORIGINAL numbers', async () => {
    // THE product guarantee. A decision made under version 1 must remain
    // explainable against version 1's limit, even after version 2 raised it.
    await withRollback(async (client) => {
      await seedFixtures(client);
      await createBaseMandate(client); // v1: ₹1,500 per txn

      await insertVersion(client, {
        mandateId: MANDATE_ID,
        version: 2,
        terms: terms({ perTxnLimitPaise: 500_000 }),
        merchantIds: ['mer_test_shop'],
        createdBy: 'test',
        changeReason: 'raised limit',
        consentRef: 'consent_test_v2',
        consentAt: new Date('2026-09-02T10:00:00Z'),
      });

      const v1 = await loadVersion(client, MANDATE_ID, 1);
      const v2 = await loadVersion(client, MANDATE_ID, 2);

      expect(v1?.terms.perTxnLimitPaise).toBe(150_000); // untouched
      expect(v2?.terms.perTxnLimitPaise).toBe(500_000);
      expect(v1?.consentRef).toBe('consent_test_v1');
    });
  });

  it('returns null for a version that does not exist', async () => {
    await withRollback(async (client) => {
      await seedFixtures(client);
      await createBaseMandate(client);

      expect(await loadVersion(client, MANDATE_ID, 99)).toBeNull();
    });
  });
});

describe('round-trip fidelity - what goes in is what comes out', () => {
  it('preserves every term exactly through insert and load', async () => {
    // Guards against a column being dropped from the SELECT list, or a value
    // being mangled by array/date conversion.
    await withRollback(async (client) => {
      await seedFixtures(client);

      const original = terms({
        perTxnLimitPaise: 123_456,
        windowLimitPaise: 987_654,
        windowKind: 'month',
        maxTxnPerHour: 3,
        blockedMccs: ['5921', '7995', '5993'],
        timezone: 'Asia/Singapore',
        windowStartHour: 9,
        windowEndHour: 21,
        allowedWeekdays: ['MON', 'WED', 'FRI'],
        paymentMethods: ['upi_reserve_pay', 'card'],
        afaExemptionThresholdPaise: 1_500_000,
      });

      await insertMandate(client, {
        mandateId: MANDATE_ID,
        userId: 'usr_test_repo',
        agentId: 'agt_test_repo',
        label: 'Fidelity test',
        terms: original,
        merchantIds: ['mer_test_shop'],
        createdBy: 'test',
        changeReason: null,
        consentRef: 'consent_test_fidelity',
        consentAt: new Date('2026-09-01T08:55:00Z'),
      });

      const loaded = await loadForAuthorization(client, MANDATE_ID);
      const got = loaded?.version.terms;

      expect(got?.perTxnLimitPaise).toBe(original.perTxnLimitPaise);
      expect(got?.windowLimitPaise).toBe(original.windowLimitPaise);
      expect(got?.windowKind).toBe('month');
      expect(got?.maxTxnPerHour).toBe(3);
      expect(got?.blockedMccs).toEqual(['5921', '7995', '5993']);
      expect(got?.timezone).toBe('Asia/Singapore');
      expect(got?.windowStartHour).toBe(9);
      expect(got?.windowEndHour).toBe(21);
      expect(got?.allowedWeekdays).toEqual(['MON', 'WED', 'FRI']);
      expect(got?.paymentMethods).toEqual(['upi_reserve_pay', 'card']);
      expect(got?.afaExemptionThresholdPaise).toBe(1_500_000);
      expect(got?.validFrom.toISOString()).toBe(original.validFrom.toISOString());
      expect(got?.validTo.toISOString()).toBe(original.validTo.toISOString());
    });
  });

  it('returns money as a number, not a string', async () => {
    // node-postgres hands back bigint as a string by default; our int8 parser
    // is what makes this a number.
    await withRollback(async (client) => {
      await seedFixtures(client);
      await createBaseMandate(client);

      const loaded = await loadForAuthorization(client, MANDATE_ID);
      expect(typeof loaded?.version.terms.perTxnLimitPaise).toBe('number');
    });
  });
});

describe('listVersions', () => {
  it('returns every version, oldest first', async () => {
    await withRollback(async (client) => {
      await seedFixtures(client);
      await createBaseMandate(client);

      for (const version of [2, 3]) {
        await insertVersion(client, {
          mandateId: MANDATE_ID,
          version,
          terms: terms(),
          merchantIds: ['mer_test_shop'],
          createdBy: 'test',
          changeReason: `version ${version}`,
          consentRef: `consent_test_v${version}`,
          consentAt: new Date('2026-09-02T10:00:00Z'),
        });
      }

      const versions = await listVersions(client, MANDATE_ID);

      expect(versions.map((v) => v.version)).toEqual([1, 2, 3]);
    });
  });

  it('returns an empty array for an unknown mandate', async () => {
    await withRollback(async (client) => {
      expect(await listVersions(client, 'mnd_test_missing')).toEqual([]);
    });
  });
});

describe('nextVersionNumber', () => {
  it('starts at 1 and increments', async () => {
    await withRollback(async (client) => {
      await seedFixtures(client);
      await createBaseMandate(client);

      expect(await nextVersionNumber(client, MANDATE_ID)).toBe(2);

      await insertVersion(client, {
        mandateId: MANDATE_ID,
        version: 2,
        terms: terms(),
        merchantIds: [],
        createdBy: 'test',
        changeReason: null,
        consentRef: 'consent_test_v2',
        consentAt: new Date('2026-09-02T10:00:00Z'),
      });

      expect(await nextVersionNumber(client, MANDATE_ID)).toBe(3);
    });
  });
});

describe('revokeMandate', () => {
  it('revokes an active mandate and records who and why', async () => {
    await withRollback(async (client) => {
      await seedFixtures(client);
      await createBaseMandate(client);

      const revoked = await revokeMandate(client, {
        mandateId: MANDATE_ID,
        revokedBy: 'usr_test_repo',
        revokedReason: 'user withdrew consent',
      });

      expect(revoked).toBe(true);

      const loaded = await loadForAuthorization(client, MANDATE_ID);
      expect(loaded?.mandate.status).toBe('revoked');
      expect(loaded?.mandate.revokedBy).toBe('usr_test_repo');
      expect(loaded?.mandate.revokedReason).toBe('user withdrew consent');
      expect(loaded?.mandate.revokedAt).toBeInstanceOf(Date);
    });
  });

  it('returns false on a second revocation instead of erroring', async () => {
    // `AND status = 'active'` makes the repeat affect no rows. Without it the
    // lifecycle trigger would refuse the update and the caller would get a
    // confusing 500 for what is really "already done".
    await withRollback(async (client) => {
      await seedFixtures(client);
      await createBaseMandate(client);

      const params = {
        mandateId: MANDATE_ID,
        revokedBy: 'usr_test_repo',
        revokedReason: 'first',
      };

      expect(await revokeMandate(client, params)).toBe(true);
      expect(await revokeMandate(client, { ...params, revokedReason: 'second' })).toBe(false);

      // And the original reason survived - a no-op must not overwrite it.
      const loaded = await loadForAuthorization(client, MANDATE_ID);
      expect(loaded?.mandate.revokedReason).toBe('first');
    });
  });

  it('returns false for a mandate that does not exist', async () => {
    await withRollback(async (client) => {
      expect(
        await revokeMandate(client, {
          mandateId: 'mnd_test_missing',
          revokedBy: 'x',
          revokedReason: 'y',
        }),
      ).toBe(false);
    });
  });
});

describe('newMandateId', () => {
  it('produces ids the database will accept', async () => {
    for (let i = 0; i < 20; i += 1) {
      expect(newMandateId()).toMatch(/^mnd_[a-z0-9]{20}$/);
    }
  });

  it('produces distinct ids', () => {
    const ids = new Set(Array.from({ length: 200 }, () => newMandateId()));
    expect(ids.size).toBe(200);
  });
});
