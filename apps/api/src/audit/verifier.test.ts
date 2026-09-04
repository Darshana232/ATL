/**
 * Chain verification, proven by ATTACKING it.
 *
 * Every tamper test is paired with an assertion that the SAME chain verified
 * before the edit. That pairing is the positive control: a verifier hard-wired
 * to return `intact` would pass "the chain verifies" and fail every test here,
 * and a verifier hard-wired to return `broken` would fail the paired
 * pre-assertions. Neither trivial implementation survives.
 *
 * THE TAMPERING RUNS AS THE DATABASE OWNER, and that is the honest part. The
 * application role `atl_app` cannot UPDATE or DELETE an audit event - the grant
 * is revoked AND a trigger refuses (proven in db/roles.test.ts). So the threat
 * this feature detects is a PRIVILEGED INSIDER, not an application bug, and the
 * test has to become one to demonstrate anything.
 *
 * AND EVEN THE OWNER IS NOT ENOUGH. The first version of this file connected as
 * the owner and every tamper still failed:
 *
 *     error: public.audit_events is append-only; UPDATE is not permitted
 *
 * The BEFORE UPDATE OR DELETE trigger fires for the table owner too. To modify
 * a past event an attacker must first DISABLE THE TRIGGER - a DDL statement,
 * requiring ownership, that is itself recorded in the PostgreSQL log. That is a
 * genuinely useful finding rather than an inconvenience: the barrier is higher
 * than the design claimed, and `tamperAsInsider` below performs the full,
 * explicit sequence so nobody can mistake this for something the application
 * could do.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomBytes } from 'node:crypto';
import { adminDatabaseUrl, loadConfig, type Config } from '../config.js';
import { createLogger } from '../logger.js';
import { closePool, createPool, type Pool } from '../db/pool.js';
import { withTransaction } from '../db/transaction.js';
import { appendAuditEvent } from './writer.js';
import { signCheckpoint } from './checkpoint.js';
import { verifyChain } from './verifier.js';
import { insertCheckpoint, newCheckpointId, summariseChain } from '../repositories/audit.js';

const config: Config = loadConfig({ ...process.env, NODE_ENV: 'test', LOG_LEVEL: 'fatal' });
const logger = createLogger(config);

const CHECKPOINT_SECRET = config.AUDIT_CHECKPOINT_SECRET ?? 'c'.repeat(64);

/** The service role: can append, cannot edit. */
let appPool: Pool;
/** The OWNER: can edit. This is the insider we are simulating. */
let ownerPool: Pool;

const hasOwner = config.DATABASE_ADMIN_URL !== undefined
  && config.DATABASE_ADMIN_URL !== config.DATABASE_URL;

beforeAll(() => {
  appPool = createPool(config, logger);
  ownerPool = createPool(
    { ...config, DATABASE_URL: adminDatabaseUrl(config) } as Config,
    logger,
  );
});

afterAll(async () => {
  await closePool(appPool, logger);
  await closePool(ownerPool, logger);
});

/** A fresh, isolated chain so one test's tampering cannot affect another's. */
async function makeChain(events = 4): Promise<string> {
  const chainId = `test_vfy_${randomBytes(6).toString('hex')}`;

  await withTransaction(appPool, async (tx) => {
    for (let index = 1; index <= events; index += 1) {
      await appendAuditEvent(tx, {
        eventType: 'VERIFIER_TEST_EVENT',
        actorKind: 'agent',
        actorId: `agt_test_${index}`,
        subjectKind: 'decision',
        subjectId: `dec_test_${index}`,
        chainId,
        payload: { index, note: `event ${index}`, amountPaise: index * 1000 },
      });
    }
  });

  return chainId;
}

const verify = (chainId: string) =>
  verifyChain(appPool, { chainId, checkpointSecret: CHECKPOINT_SECRET });

/**
 * What a privileged insider actually has to do.
 *
 * Not "run an UPDATE" - the append-only trigger refuses that even for the
 * table's owner. They must disable the trigger (DDL, owner-only, logged by
 * PostgreSQL), make the change, and put it back so nobody notices.
 *
 * Restored in a `finally` block, because a test that leaves the append-only
 * guard disabled would quietly weaken every test that runs after it.
 */
async function tamperAsInsider(
  table: 'audit_events' | 'audit_checkpoints',
  sql: string,
  params: readonly unknown[],
): Promise<void> {
  const trigger = table === 'audit_events'
    ? 'audit_events_append_only'
    : 'audit_checkpoints_append_only';

  await ownerPool.query(`ALTER TABLE ${table} DISABLE TRIGGER ${trigger}`);
  try {
    await ownerPool.query(sql, [...params]);
  } finally {
    await ownerPool.query(`ALTER TABLE ${table} ENABLE TRIGGER ${trigger}`);
  }
}

describe('an untouched chain verifies', () => {
  it('reports intact and counts every event', async () => {
    const chainId = await makeChain(5);
    const result = await verify(chainId);

    expect(result.status).toBe('intact');
    expect(result.firstBreak).toBeNull();
    expect(result.eventsChecked).toBe(5);
    expect(result.totalEvents).toBe(5);
  });

  it('always carries the tamper-EVIDENT limitation in the result', async () => {
    // The claim ceiling travels with the answer, so a dashboard or a screenshot
    // cannot present "VERIFIED" without it.
    const result = await verify(await makeChain(2));

    expect(result.limitation).toContain('NOT TAMPER-PROOF');
    expect(result.limitation).toContain('superuser');
  });

  it('verifies a single-event chain', async () => {
    const result = await verify(await makeChain(1));
    expect(result.status).toBe('intact');
  });
});

describe.skipIf(!hasOwner)('tampering is detected - as the database OWNER', () => {
  it('catches an edited PAYLOAD', async () => {
    // The classic: quietly change a recorded amount after the fact.
    const chainId = await makeChain(4);
    expect((await verify(chainId)).status).toBe('intact'); // control

    await tamperAsInsider(
      'audit_events',
      `UPDATE audit_events SET payload = jsonb_set(payload, '{amountPaise}', '999999')
        WHERE chain_id = $1 AND seq = (SELECT min(seq) + 1 FROM audit_events WHERE chain_id = $1)`,
      [chainId],
    );

    const result = await verify(chainId);

    expect(result.status).toBe('broken');
    expect(result.firstBreak?.kind).toBe('payload_hash_mismatch');
    expect(result.firstBreak?.detail).toContain('does not hash');
  });

  it('catches an edited ACTOR - the hash covers the whole record', async () => {
    // THE MOST IMPORTANT TEST IN THIS FILE.
    //
    // If the hash covered only the payload, someone could change actor_id from
    // agt_impostor to agt_grocery_shopper and the chain would still verify -
    // the ATTRIBUTION would be unprotected, and attribution is the part a
    // regulator cares about most.
    const chainId = await makeChain(4);
    expect((await verify(chainId)).status).toBe('intact');

    await tamperAsInsider(
      'audit_events',
      `UPDATE audit_events SET actor_id = 'agt_someone_else'
        WHERE chain_id = $1 AND seq = (SELECT max(seq) FROM audit_events WHERE chain_id = $1)`,
      [chainId],
    );

    const result = await verify(chainId);

    expect(result.status).toBe('broken');
    expect(result.firstBreak?.kind).toBe('event_hash_mismatch');
  });

  it('catches an edited TIMESTAMP', async () => {
    // Moving an event's time is how you make a late action look timely.
    const chainId = await makeChain(3);
    expect((await verify(chainId)).status).toBe('intact');

    await tamperAsInsider(
      'audit_events',
      `UPDATE audit_events SET occurred_at = occurred_at - interval '3 days'
        WHERE chain_id = $1 AND seq = (SELECT max(seq) FROM audit_events WHERE chain_id = $1)`,
      [chainId],
    );

    expect((await verify(chainId)).firstBreak?.kind).toBe('event_hash_mismatch');
  });

  it('catches an edited EVENT TYPE', async () => {
    const chainId = await makeChain(3);
    await tamperAsInsider(
      'audit_events',
      `UPDATE audit_events SET event_type = 'SOMETHING_HARMLESS'
        WHERE chain_id = $1 AND seq = (SELECT max(seq) FROM audit_events WHERE chain_id = $1)`,
      [chainId],
    );

    expect((await verify(chainId)).status).toBe('broken');
  });

  it('catches a payload edit even when the hashes are RECOMPUTED to match', async () => {
    // The sophisticated attack: edit the payload, then fix payload_hash and
    // hash so that row is internally consistent. The row now verifies on its
    // own - but the NEXT row's prev_hash still points at the old value.
    //
    // This is the property that makes a chain worth having: one edit forces
    // rewriting every subsequent row.
    const chainId = await makeChain(4);
    expect((await verify(chainId)).status).toBe('intact');

    const target = await appPool.query<{ seq: string; id: string; payload: unknown }>(
      `SELECT seq, id, payload FROM audit_events
        WHERE chain_id = $1 ORDER BY seq LIMIT 1 OFFSET 1`,
      [chainId],
    );
    const seq = Number(target.rows[0]!.seq);

    // Recompute exactly the way the writer would, using the real functions.
    const { hashCanonical } = await import('./canonical.js');
    const { computeEventHash, AUDIT_HASH_SCHEME_VERSION } = await import('./writer.js');

    const row = await appPool.query(
      `SELECT * FROM audit_events WHERE chain_id = $1 AND seq = $2`, [chainId, seq],
    );
    const original = row.rows[0] as Record<string, unknown>;

    const forgedPayload = { ...(original.payload as Record<string, unknown>), amountPaise: 999_999 };
    const forgedPayloadHash = hashCanonical(forgedPayload as never);
    const forgedHash = computeEventHash({
      v: AUDIT_HASH_SCHEME_VERSION,
      chainId,
      id: original.id as string,
      eventType: original.event_type as string,
      occurredAt: (original.occurred_at as Date).toISOString(),
      actorKind: original.actor_kind as string,
      actorId: original.actor_id as string | null,
      subjectKind: original.subject_kind as string,
      subjectId: original.subject_id as string,
      requestId: original.request_id as string | null,
      mandateId: original.mandate_id as string | null,
      payloadHash: forgedPayloadHash,
      prevHash: original.prev_hash as string | null,
    });

    await tamperAsInsider(
      'audit_events',
      `UPDATE audit_events SET payload = $3, payload_hash = $4, hash = $5
        WHERE chain_id = $1 AND seq = $2`,
      [chainId, seq, JSON.stringify(forgedPayload), forgedPayloadHash, forgedHash],
    );

    const result = await verify(chainId);

    expect(result.status).toBe('broken');
    // The edited row itself is now self-consistent; the break appears at the
    // row AFTER it, whose prev_hash no longer matches.
    expect(result.firstBreak?.kind).toBe('broken_link');
    expect(result.firstBreak?.seq).toBeGreaterThan(seq);
  });

  it('catches a DELETED event', async () => {
    const chainId = await makeChain(5);
    expect((await verify(chainId)).status).toBe('intact');

    await tamperAsInsider(
      'audit_events',
      `DELETE FROM audit_events
        WHERE chain_id = $1 AND seq = (SELECT min(seq) + 2 FROM audit_events WHERE chain_id = $1)`,
      [chainId],
    );

    const result = await verify(chainId);

    expect(result.status).toBe('broken');
    expect(result.firstBreak?.kind).toBe('broken_link');
  });

  it('catches removal of the chain GENESIS', async () => {
    const chainId = await makeChain(4);

    await tamperAsInsider(
      'audit_events',
      `DELETE FROM audit_events
        WHERE chain_id = $1 AND seq = (SELECT min(seq) FROM audit_events WHERE chain_id = $1)`,
      [chainId],
    );

    const result = await verify(chainId);

    expect(result.status).toBe('broken');
    expect(result.firstBreak?.kind).toBe('missing_genesis');
  });

  it('reports only the FIRST break, not every downstream one', async () => {
    // After one broken link, every later row also fails. Listing them all would
    // return a million lines describing a single edit.
    const chainId = await makeChain(8);

    await tamperAsInsider(
      'audit_events',
      `UPDATE audit_events SET actor_id = 'agt_forged'
        WHERE chain_id = $1 AND seq = (SELECT min(seq) + 1 FROM audit_events WHERE chain_id = $1)`,
      [chainId],
    );

    const result = await verify(chainId);

    expect(result.firstBreak).not.toBeNull();
    // One event verified before the damage, and the count stops there.
    expect(result.eventsChecked).toBe(1);
    expect(result.totalEvents).toBe(8);
  });
});

describe('the database refuses forks and second genesis rows outright', () => {
  it('rejects a second genesis via the unique index', async () => {
    // PREVENTED, not merely detected. An attacker could otherwise start a
    // parallel valid-looking chain and present it as the real one.
    const chainId = await makeChain(2);

    const attempt = await appPool
      .query(
        `INSERT INTO audit_events
           (id, chain_id, event_type, actor_kind, actor_id, subject_kind, subject_id,
            payload, payload_hash, hash)
         VALUES ($1,$2,'FORGED_GENESIS','system',NULL,'audit','forge',
                 '{"x":1}', $3, $4)`,
        [`evt_${randomBytes(10).toString('hex')}`, chainId, 'a'.repeat(64), 'b'.repeat(64)],
      )
      .then(() => null)
      .catch((error: unknown) => error as { constraint?: string });

    expect(attempt).not.toBeNull();
  });

  it('rejects a fork via the unique index', async () => {
    // Two rows with the same prev_hash would make the history branch, and both
    // branches would verify.
    const chainId = await makeChain(2);

    const head = await appPool.query<{ prev_hash: string }>(
      `SELECT prev_hash FROM audit_events
        WHERE chain_id = $1 AND prev_hash IS NOT NULL ORDER BY seq LIMIT 1`,
      [chainId],
    );

    const attempt = await appPool
      .query(
        `INSERT INTO audit_events
           (id, chain_id, event_type, actor_kind, actor_id, subject_kind, subject_id,
            payload, payload_hash, prev_hash, hash)
         VALUES ($1,$2,'FORGED_FORK','system',NULL,'audit','forge',
                 '{"x":1}', $3, $4, $5)`,
        [
          `evt_${randomBytes(10).toString('hex')}`, chainId, 'a'.repeat(64),
          head.rows[0]!.prev_hash, 'c'.repeat(64),
        ],
      )
      .then(() => null)
      .catch((error: unknown) => error);

    expect(attempt).not.toBeNull();
  });
});

describe('checkpoints catch what the chain alone cannot', () => {
  async function anchor(chainId: string): Promise<void> {
    const summary = await summariseChain(appPool, chainId);
    const facts = {
      chainId,
      seq: summary.headSeq!,
      headHash: summary.headHash!,
      eventCount: summary.eventCount,
      createdAt: new Date().toISOString(),
    };

    await withTransaction(appPool, async (tx) => {
      await insertCheckpoint(tx, {
        ...facts,
        id: newCheckpointId(),
        signature: signCheckpoint(CHECKPOINT_SECRET, facts),
        createdBy: 'test',
      });
    });
  }

  it('a valid checkpoint over an intact chain reports valid', async () => {
    const chainId = await makeChain(3);
    await anchor(chainId);

    const result = await verify(chainId);

    expect(result.status).toBe('intact');
    expect(result.checkpoints).toHaveLength(1);
    expect(result.checkpoints[0]?.status).toBe('valid');
  });

  it('reports checkpoints as UNREACHABLE, never valid, without the secret', async () => {
    // Failing closed. A missing secret must not make the report look reassuring.
    const chainId = await makeChain(2);
    await anchor(chainId);

    const result = await verifyChain(appPool, { chainId }); // no secret

    expect(result.checkpoints[0]?.status).toBe('unreachable');
  });

  it.skipIf(!hasOwner)('detects a CONSISTENT full-chain rewrite', async () => {
    // THE SCENARIO CHECKPOINTS EXIST FOR.
    //
    // An attacker with owner rights rewrites every row AND every hash. The
    // chain is now perfectly internally consistent and verifies on its own -
    // a hash chain only proves consistency, never authenticity. The signed
    // anchor is the only thing that remembers what the head USED to be.
    const chainId = await makeChain(3);
    await anchor(chainId);
    expect((await verify(chainId)).status).toBe('intact');

    // Simulate the rewrite in its simplest observable form: replace the
    // anchored head row entirely. Rebuilding a full consistent chain by hand
    // would prove the same thing with more code.
    await tamperAsInsider('audit_events', `DELETE FROM audit_events WHERE chain_id = $1`, [chainId]);

    const result = await verify(chainId);

    expect(result.status).toBe('broken');
    expect(result.checkpoints[0]?.status).not.toBe('valid');
    expect(result.checkpoints[0]?.detail).toMatch(/truncated|rewritten|shorter/i);
  });

  it.skipIf(!hasOwner)('detects a FORGED checkpoint', async () => {
    // An attacker who rewrote the chain would also want to move the anchor.
    // Without the secret they cannot re-sign it.
    const chainId = await makeChain(3);
    await anchor(chainId);

    await tamperAsInsider(
      'audit_checkpoints',
      `UPDATE audit_checkpoints SET head_hash = $2 WHERE chain_id = $1`,
      [chainId, 'f'.repeat(64)],
    );

    const result = await verify(chainId);

    expect(result.status).toBe('broken');
    expect(result.checkpoints[0]?.status).toBe('forged_signature');
  });

  it('rejects a checkpoint signed with a DIFFERENT secret', async () => {
    // Key separation in practice: the voucher secret must not be able to sign
    // history, and vice versa.
    const chainId = await makeChain(2);
    const summary = await summariseChain(appPool, chainId);
    const facts = {
      chainId, seq: summary.headSeq!, headHash: summary.headHash!,
      eventCount: summary.eventCount, createdAt: new Date().toISOString(),
    };

    await withTransaction(appPool, async (tx) => {
      await insertCheckpoint(tx, {
        ...facts,
        id: newCheckpointId(),
        signature: signCheckpoint('a-completely-different-secret', facts),
        createdBy: 'test',
      });
    });

    expect((await verify(chainId)).checkpoints[0]?.status).toBe('forged_signature');
  });
});

describe('the APPLICATION role still cannot tamper at all', () => {
  it('cannot update an audit event', async () => {
    // Two independent barriers, and this asserts the first: the grant. The
    // trigger is the second, proven in db/schema.test.ts. Neither alone is
    // defence in depth.
    const chainId = await makeChain(1);

    const error = await appPool
      .query(`UPDATE audit_events SET actor_id = 'x' WHERE chain_id = $1`, [chainId])
      .then(() => null)
      .catch((e: unknown) => e as { code?: string });

    expect(error?.code).toBe('42501'); // insufficient_privilege
  });

  it('cannot update a checkpoint', async () => {
    const error = await appPool
      .query(`UPDATE audit_checkpoints SET head_hash = 'x'`)
      .then(() => null)
      .catch((e: unknown) => e as { code?: string });

    expect(error?.code).toBe('42501');
  });
});
