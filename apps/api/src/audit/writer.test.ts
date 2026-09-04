/**
 * Audit chain integrity.
 *
 * ISOLATION NOTE. Most tests here use transaction rollback, like the schema
 * tests. The concurrency test cannot: it needs real COMMITs to create real
 * contention. Since `audit_events` is append-only by design, those rows cannot
 * be deleted afterwards - so that test writes to its own unique `chain_id`,
 * which keeps it out of the 'main' chain entirely. Test chains accumulate in
 * the dev database and are cleared by the full reset in docs/DATABASE.md.
 *
 * That is a real consequence of the design, not an oversight: we made the
 * table unclearable on purpose, and tests have to live with it.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomBytes } from 'node:crypto';
import type pg from 'pg';
import { adminDatabaseUrl, loadConfig, type Config } from '../config.js';
import { createLogger } from '../logger.js';
import { closePool, createPool, type Pool } from '../db/pool.js';
import {
  AUDIT_HASH_SCHEME_VERSION,
  appendAuditEvent,
  computeEventHash,
  newAuditEventId,
  readChainHead,
} from './writer.js';

const config: Config = loadConfig({ ...process.env, NODE_ENV: 'test', LOG_LEVEL: 'fatal' });
const logger = createLogger(config);

let pool: Pool;

beforeAll(() => {
  pool = createPool(config, logger, adminDatabaseUrl(config));
});

afterAll(async () => {
  await closePool(pool, logger);
});

/** A fresh chain id per test, so tests never interfere with each other. */
function testChainId(): string {
  return `test_${randomBytes(6).toString('hex')}`;
}

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

const samplePayload = { mandateId: 'mnd_x', label: 'Weekly groceries' } as const;

describe('appendAuditEvent - chain construction', () => {
  it('the first event in a chain is genesis: prev_hash is null', async () => {
    await withRollback(async (client) => {
      const chainId = testChainId();

      const event = await appendAuditEvent(client, {
        chainId,
        eventType: 'MANDATE_CREATED',
        actorKind: 'user',
        actorId: 'usr_test',
        subjectKind: 'mandate',
        subjectId: 'mnd_x',
        payload: samplePayload,
      });

      expect(event.prevHash).toBeNull();
      expect(event.hash).toMatch(/^[0-9a-f]{64}$/);
      expect(event.id).toMatch(/^evt_[0-9a-f]{24}$/);
    });
  });

  it('each subsequent event links to its predecessor', async () => {
    await withRollback(async (client) => {
      const chainId = testChainId();

      const first = await appendAuditEvent(client, {
        chainId,
        eventType: 'MANDATE_CREATED',
        actorKind: 'user',
        actorId: 'usr_test',
        subjectKind: 'mandate',
        subjectId: 'mnd_x',
        payload: samplePayload,
      });

      const second = await appendAuditEvent(client, {
        chainId,
        eventType: 'MANDATE_VERSION_ADDED',
        actorKind: 'user',
        actorId: 'usr_test',
        subjectKind: 'mandate_version',
        subjectId: 'mnd_x:2',
        payload: { version: 2 },
      });

      expect(second.prevHash).toBe(first.hash);
      expect(second.hash).not.toBe(first.hash);
    });
  });

  it('the hash is reproducible from the stored row', async () => {
    // If this fails, Phase 6 verification is impossible - the row would not
    // contain enough information to recompute its own hash.
    await withRollback(async (client) => {
      const chainId = testChainId();

      const event = await appendAuditEvent(client, {
        chainId,
        eventType: 'MANDATE_CREATED',
        actorKind: 'user',
        actorId: 'usr_test',
        subjectKind: 'mandate',
        subjectId: 'mnd_x',
        requestId: 'req_abc',
        mandateId: 'mnd_x',
        payload: samplePayload,
      });

      const { rows } = await client.query<{
        id: string;
        chain_id: string;
        event_type: string;
        occurred_at: Date;
        actor_kind: string;
        actor_id: string | null;
        subject_kind: string;
        subject_id: string;
        request_id: string | null;
        mandate_id: string | null;
        payload_hash: string;
        prev_hash: string | null;
        hash: string;
      }>(`SELECT * FROM audit_events WHERE id = $1`, [event.id]);

      const row = rows[0];
      expect(row).toBeDefined();
      if (row === undefined) return;

      const recomputed = computeEventHash({
        v: AUDIT_HASH_SCHEME_VERSION,
        chainId: row.chain_id,
        id: row.id,
        eventType: row.event_type,
        occurredAt: row.occurred_at.toISOString(),
        actorKind: row.actor_kind,
        actorId: row.actor_id,
        subjectKind: row.subject_kind,
        subjectId: row.subject_id,
        requestId: row.request_id,
        mandateId: row.mandate_id,
        payloadHash: row.payload_hash,
        prevHash: row.prev_hash,
      });

      expect(recomputed).toBe(row.hash);
    });
  });
});

describe('the hash covers the WHOLE record, not just the payload', () => {
  /**
   * If only `payload` were hashed, these columns could all be altered without
   * breaking the chain - and they are exactly the fields an investigation
   * cares about.
   */
  const base = {
    v: AUDIT_HASH_SCHEME_VERSION,
    chainId: 'main',
    id: 'evt_000000000000000000000001',
    eventType: 'MANDATE_CREATED',
    occurredAt: '2026-09-04T10:00:00.000Z',
    actorKind: 'user',
    actorId: 'usr_a',
    subjectKind: 'mandate',
    subjectId: 'mnd_x',
    requestId: 'req_1',
    mandateId: 'mnd_x',
    payloadHash: 'a'.repeat(64),
    prevHash: null,
  } as const;

  const original = computeEventHash(base);

  it.each([
    ['occurredAt', { occurredAt: '2026-09-04T10:00:01.000Z' }],
    ['actorId', { actorId: 'usr_b' }],
    ['actorKind', { actorKind: 'admin' }],
    ['subjectId', { subjectId: 'mnd_y' }],
    ['eventType', { eventType: 'MANDATE_REVOKED' }],
    ['requestId', { requestId: 'req_2' }],
    ['mandateId', { mandateId: 'mnd_y' }],
    ['payloadHash', { payloadHash: 'b'.repeat(64) }],
    ['prevHash', { prevHash: 'c'.repeat(64) }],
    ['chainId', { chainId: 'other' }],
  ])('changing %s changes the hash', (_field, override) => {
    expect(computeEventHash({ ...base, ...override })).not.toBe(original);
  });

  it('is stable when nothing changes', () => {
    expect(computeEventHash({ ...base })).toBe(original);
  });
});

describe('database-level chain integrity', () => {
  it('REFUSES a second genesis row in the same chain', async () => {
    // Otherwise an attacker could start a parallel, valid-looking chain and
    // present it as the real history.
    await withRollback(async (client) => {
      const chainId = testChainId();

      await appendAuditEvent(client, {
        chainId,
        eventType: 'SYSTEM_INITIALISED',
        actorKind: 'system',
        actorId: null,
        subjectKind: 'audit',
        subjectId: chainId,
        payload: { note: 'genesis' },
      });

      // Hand-rolled insert with prev_hash NULL again.
      const error = await client
        .query(
          `INSERT INTO audit_events
             (id, chain_id, event_type, actor_kind, subject_kind, subject_id,
              payload, payload_hash, prev_hash, hash)
           VALUES ($1,$2,'FORGED','system','audit','x','{"a":1}',$3,NULL,$4)`,
          [newAuditEventId(), chainId, 'd'.repeat(64), 'e'.repeat(64)],
        )
        .then(() => null)
        .catch((e: unknown) => e as Error & { code?: string; constraint?: string });

      expect(error?.code).toBe('23505'); // unique_violation
      expect(error?.constraint).toBe('audit_events_single_genesis_idx');
    });
  });

  it('REFUSES forking the chain at the same predecessor', async () => {
    // Two rows claiming the same prev_hash would mean two divergent histories
    // that both verify.
    await withRollback(async (client) => {
      const chainId = testChainId();

      const first = await appendAuditEvent(client, {
        chainId,
        eventType: 'MANDATE_CREATED',
        actorKind: 'user',
        actorId: 'usr_test',
        subjectKind: 'mandate',
        subjectId: 'mnd_x',
        payload: samplePayload,
      });

      await appendAuditEvent(client, {
        chainId,
        eventType: 'MANDATE_REVOKED',
        actorKind: 'user',
        actorId: 'usr_test',
        subjectKind: 'mandate',
        subjectId: 'mnd_x',
        payload: { reason: 'legitimate' },
      });

      // A third row pointing back at `first` - a fork.
      const error = await client
        .query(
          `INSERT INTO audit_events
             (id, chain_id, event_type, actor_kind, subject_kind, subject_id,
              payload, payload_hash, prev_hash, hash)
           VALUES ($1,$2,'FORGED','system','audit','x','{"a":1}',$3,$4,$5)`,
          [newAuditEventId(), chainId, 'd'.repeat(64), first.hash, 'f'.repeat(64)],
        )
        .then(() => null)
        .catch((e: unknown) => e as Error & { code?: string; constraint?: string });

      expect(error?.code).toBe('23505');
      expect(error?.constraint).toBe('audit_events_no_fork_idx');
    });
  });
});

describe('concurrent appends', () => {
  it('serialises 12 simultaneous appends into one unbroken chain', async () => {
    /**
     * THE test for the advisory lock. Without it, all twelve transactions read
     * the same chain head, compute the same prev_hash, and eleven of them are
     * rejected by the no-fork unique index - a legitimate append failing
     * because another one happened at the same moment.
     *
     * This test COMMITS (real contention needs real transactions), so it uses
     * its own chain id. See the note at the top of this file.
     */
    const chainId = testChainId();
    const appendCount = 12;

    const results = await Promise.all(
      Array.from({ length: appendCount }, async (_unused, index) => {
        const client = await pool.connect();
        try {
          await client.query('BEGIN');
          const event = await appendAuditEvent(client, {
            chainId,
            eventType: 'CONCURRENCY_PROBE',
            actorKind: 'system',
            actorId: null,
            subjectKind: 'audit',
            subjectId: `probe_${index}`,
            payload: { index },
          });
          await client.query('COMMIT');
          return event;
        } catch (error) {
          await client.query('ROLLBACK').catch(() => {});
          throw error;
        } finally {
          client.release();
        }
      }),
    );

    // Every append succeeded - none lost a race.
    expect(results).toHaveLength(appendCount);

    // And the chain is unbroken: read it back in order and walk the links.
    const { rows } = await pool.query<{ seq: number; hash: string; prev_hash: string | null }>(
      `SELECT seq, hash, prev_hash FROM audit_events WHERE chain_id = $1 ORDER BY seq`,
      [chainId],
    );

    expect(rows).toHaveLength(appendCount);
    expect(rows[0]?.prev_hash).toBeNull(); // exactly one genesis

    for (let i = 1; i < rows.length; i += 1) {
      expect(rows[i]?.prev_hash).toBe(rows[i - 1]?.hash);
    }

    // No duplicate hashes anywhere in the chain.
    expect(new Set(rows.map((row) => row.hash)).size).toBe(appendCount);
  });
});

describe('readChainHead', () => {
  it('returns null for an empty chain', async () => {
    await withRollback(async (client) => {
      expect(await readChainHead(client, testChainId())).toBeNull();
    });
  });

  it('returns the most recent hash', async () => {
    await withRollback(async (client) => {
      const chainId = testChainId();

      await appendAuditEvent(client, {
        chainId,
        eventType: 'FIRST_EVENT',
        actorKind: 'system',
        actorId: null,
        subjectKind: 'audit',
        subjectId: 'x',
        payload: { n: 1 },
      });
      const second = await appendAuditEvent(client, {
        chainId,
        eventType: 'SECOND_EVENT',
        actorKind: 'system',
        actorId: null,
        subjectKind: 'audit',
        subjectId: 'x',
        payload: { n: 2 },
      });

      expect(await readChainHead(client, chainId)).toBe(second.hash);
    });
  });

  it('chains are independent of each other', async () => {
    // The escape hatch for the throughput limit: shard by chain.
    await withRollback(async (client) => {
      const chainA = testChainId();
      const chainB = testChainId();

      const a = await appendAuditEvent(client, {
        chainId: chainA,
        eventType: 'EVENT_A',
        actorKind: 'system',
        actorId: null,
        subjectKind: 'audit',
        subjectId: 'a',
        payload: { chain: 'a' },
      });
      const b = await appendAuditEvent(client, {
        chainId: chainB,
        eventType: 'EVENT_B',
        actorKind: 'system',
        actorId: null,
        subjectKind: 'audit',
        subjectId: 'b',
        payload: { chain: 'b' },
      });

      // Both are genesis rows in their own chain.
      expect(a.prevHash).toBeNull();
      expect(b.prevHash).toBeNull();
      expect(await readChainHead(client, chainA)).toBe(a.hash);
      expect(await readChainHead(client, chainB)).toBe(b.hash);
    });
  });
});
