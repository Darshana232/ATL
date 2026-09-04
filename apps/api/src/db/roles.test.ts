/**
 * Least privilege: what the APPLICATION role can and cannot do.
 *
 * This file connects as the service actually connects - DATABASE_URL, the
 * `atl_app` role - and proves the privilege boundary from migration 0005.
 *
 * It is the complement of schema.test.ts, which connects as the owner to test
 * triggers and constraints. The distinction matters:
 *
 *   as atl_app  an UPDATE on an append-only table is refused at the
 *               PERMISSION layer (42501), before any trigger runs
 *   as owner    the permission check passes and the TRIGGER refuses (ATL01)
 *
 * Two independent barriers. The grant stops application bugs; the trigger
 * stops a misconfigured grant. Neither alone is defence in depth, and each is
 * verified separately - because a test that only ever exercises one of them
 * cannot tell you the other exists.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomBytes } from 'node:crypto';
import { loadConfig, type Config } from '../config.js';
import { createLogger } from '../logger.js';
import { closePool, createPool, type Pool } from './pool.js';

const config: Config = loadConfig({ ...process.env, NODE_ENV: 'test', LOG_LEVEL: 'fatal' });
const logger = createLogger(config);

/** PostgreSQL: insufficient_privilege. */
const INSUFFICIENT_PRIVILEGE = '42501';

type DbError = Error & { code?: string };

let appPool: Pool;

/**
 * Skip the whole file when the service and the migrator share credentials -
 * there is no privilege boundary to test, and asserting one would fail for a
 * configuration reason rather than a code reason.
 */
const hasSeparateRoles = config.DATABASE_ADMIN_URL !== undefined
  && config.DATABASE_ADMIN_URL !== config.DATABASE_URL;

beforeAll(() => {
  appPool = createPool(config, logger);
});

afterAll(async () => {
  await closePool(appPool, logger);
});

async function attempt(sql: string): Promise<DbError | null> {
  try {
    await appPool.query(sql);
    return null;
  } catch (error) {
    return error as DbError;
  }
}

describe.skipIf(!hasSeparateRoles)('the application role is genuinely restricted', () => {
  it('connects as atl_app, not as the owner', async () => {
    // If this fails, every assertion below is meaningless - it would be the
    // owner passing tests about a restricted role.
    const { rows } = await appPool.query<{ current_user: string }>('SELECT current_user');
    expect(rows[0]?.current_user).toBe('atl_app');
  });

  it('CANNOT update an audit event', async () => {
    const error = await attempt(`UPDATE audit_events SET payload = '{"note":"tampered"}'`);
    expect(error?.code).toBe(INSUFFICIENT_PRIVILEGE);
  });

  it('CANNOT delete an audit event', async () => {
    const error = await attempt(`DELETE FROM audit_events`);
    expect(error?.code).toBe(INSUFFICIENT_PRIVILEGE);
  });

  it('CANNOT truncate the audit trail', async () => {
    // TRUNCATE bypasses row-level triggers, so this permission denial is the
    // barrier that matters most for that particular statement.
    const error = await attempt(`TRUNCATE audit_events`);
    expect(error?.code).toBe(INSUFFICIENT_PRIVILEGE);
  });

  it('CANNOT drop the audit table', async () => {
    const error = await attempt(`DROP TABLE audit_events`);
    expect(error?.code).toBe(INSUFFICIENT_PRIVILEGE);
  });

  it('CANNOT rewrite mandate terms', async () => {
    const error = await attempt(`UPDATE mandate_versions SET per_txn_limit_paise = 1`);
    expect(error?.code).toBe(INSUFFICIENT_PRIVILEGE);
  });

  it('CANNOT alter a past decision or its rule breakdown', async () => {
    const decision = await attempt(`UPDATE decisions SET verdict = 'PASS'`);
    expect(decision?.code).toBe(INSUFFICIENT_PRIVILEGE);

    const rules = await attempt(`UPDATE rule_evaluations SET verdict = 'PASS'`);
    expect(rules?.code).toBe(INSUFFICIENT_PRIVILEGE);
  });

  it('CANNOT delete anything, anywhere', async () => {
    // The service has no legitimate reason to delete a row in this system.
    for (const table of ['merchants', 'users', 'agents', 'mandates', 'payments']) {
      const error = await attempt(`DELETE FROM ${table}`);
      expect(error?.code, `DELETE FROM ${table} should be denied`).toBe(INSUFFICIENT_PRIVILEGE);
    }
  });

  it('CANNOT rewrite the migration ledger', async () => {
    // Otherwise the application could make an applied migration look unapplied,
    // and the checksum guard could be bypassed by re-running an edited file.
    const error = await attempt(`DELETE FROM schema_migrations`);
    expect(error?.code).toBe(INSUFFICIENT_PRIVILEGE);
  });

  it('CANNOT create tables', async () => {
    const error = await attempt(`CREATE TABLE sneaky (id INT)`);
    expect(error?.code).toBe(INSUFFICIENT_PRIVILEGE);
  });
});

describe.skipIf(!hasSeparateRoles)('the application role can still do its job', () => {
  it('CAN read every table it needs', async () => {
    for (const table of [
      'merchants', 'users', 'agents', 'tools', 'agent_tool_grants', 'agent_credentials',
      'mandates', 'mandate_versions', 'mandate_version_merchants',
      'authorization_requests', 'decisions', 'rule_evaluations', 'risk_signals',
      'payments', 'audit_events',
    ]) {
      const error = await attempt(`SELECT count(*) FROM ${table}`);
      expect(error, `SELECT from ${table} should be permitted`).toBeNull();
    }
  });

  it('CAN read the migration ledger, to report the applied schema version', async () => {
    const error = await attempt(`SELECT count(*) FROM schema_migrations`);
    expect(error).toBeNull();
  });

  it('CAN append to the audit trail', async () => {
    // Append is the one thing the application MUST be able to do here.
    // Rolled back, so the append-only table is not polluted by a test.
    //
    // Uses its OWN chain_id. An earlier version wrote a genesis row (prev_hash
    // NULL) to the default 'main' chain, which passed only while that chain
    // was empty - once the route tests created real events, the single-genesis
    // index correctly rejected it. That is PHASE_02 mistake 7 again in a new
    // guise: a test with a hidden precondition on global state.
    const client = await appPool.connect();
    const chainId = `test_roles_${randomBytes(6).toString('hex')}`;
    try {
      await client.query('BEGIN');
      const inserted = await client.query(
        `INSERT INTO audit_events
           (id, chain_id, event_type, actor_kind, actor_id, subject_kind, subject_id,
            payload, payload_hash, hash)
         VALUES ('evt_roletest', $1, 'ROLE_TEST', 'system', NULL, 'audit', 'role-check',
                 '{"probe":true}', $2, $3)
         RETURNING seq`,
        [chainId, 'a'.repeat(64), 'b'.repeat(64)],
      );
      expect(inserted.rowCount).toBe(1);
    } finally {
      await client.query('ROLLBACK').catch(() => {});
      client.release();
    }
  });

  it('CAN revoke a mandate (a legitimate lifecycle change)', async () => {
    // UPDATE is granted where a real lifecycle exists - and denied where it
    // does not. That distinction is the whole point of the grant list.
    const client = await appPool.connect();
    try {
      await client.query('BEGIN');
      const error = await client
        .query(
          `UPDATE mandates
              SET status='revoked', revoked_at=now(), revoked_by='usr_x', revoked_reason='test'
            WHERE id='does_not_exist'`,
        )
        .then(() => null)
        .catch((e: unknown) => e as DbError);

      // No rows match, but the statement must be PERMITTED - we are testing
      // the grant, not the data.
      expect(error).toBeNull();
    } finally {
      await client.query('ROLLBACK').catch(() => {});
      client.release();
    }
  });
});
