/**
 * The audit endpoints over HTTP.
 *
 * These are the endpoints the Phase 8 dashboard renders, and the ones a judge
 * or an auditor would actually call. They must be honest about what they can
 * and cannot prove.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomBytes } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { adminDatabaseUrl, loadConfig, type Config } from '../config.js';
import { createLogger } from '../logger.js';
import { closePool, createPool, type Pool } from '../db/pool.js';
import { buildServer } from '../server.js';
import { withTransaction } from '../db/transaction.js';
import { appendAuditEvent } from '../audit/writer.js';
import { ADMIN_KEY_HEADER } from '../middleware/admin-auth.js';
import { insertCheckpoint, newCheckpointId, summariseChain } from '../repositories/audit.js';
import { signCheckpoint } from '../audit/checkpoint.js';

const config: Config = loadConfig({
  ...process.env,
  NODE_ENV: 'test',
  LOG_LEVEL: 'fatal',
  // Forced on, so "the admin key is required" is genuinely exercised. Without
  // it the guard logs a warning and allows the request, and every auth test
  // here would pass while proving nothing.
  ADMIN_API_KEY: process.env.ADMIN_API_KEY ?? 'k'.repeat(48),
});
const ADMIN_KEY = config.ADMIN_API_KEY!;
const logger = createLogger(config);

let pool: Pool;
let ownerPool: Pool;
let app: FastifyInstance;
let chainId: string;

const hasOwner = config.DATABASE_ADMIN_URL !== undefined
  && config.DATABASE_ADMIN_URL !== config.DATABASE_URL;

beforeAll(async () => {
  pool = createPool(config, logger);
  ownerPool = createPool({ ...config, DATABASE_URL: adminDatabaseUrl(config) } as Config, logger);
  app = buildServer({ config, logger, pool });
  await app.ready();

  chainId = `test_route_${randomBytes(6).toString('hex')}`;

  await withTransaction(pool, async (tx) => {
    for (let index = 1; index <= 4; index += 1) {
      await appendAuditEvent(tx, {
        eventType: 'ROUTE_TEST_EVENT',
        actorKind: 'admin',
        actorId: 'admin_test',
        subjectKind: 'audit',
        subjectId: `sub_${index}`,
        mandateId: index % 2 === 0 ? 'mnd_weekly_groceries' : null,
        chainId,
        payload: { index },
      });
    }
  });
});

afterAll(async () => {
  await app.close();
  await closePool(pool, logger);
  await closePool(ownerPool, logger);
});

const admin = { [ADMIN_KEY_HEADER]: ADMIN_KEY };

describe('GET /v1/audit/verify', () => {
  it('requires the admin key', async () => {
    // The trail contains merchant names, amounts and (in user_intent) personal
    // data. It is not a public endpoint.
    const response = await app.inject({ method: 'GET', url: '/v1/audit/verify' });
    expect(response.statusCode).toBe(401);
  });

  it('reports an intact chain', async () => {
    const response = await app.inject({
      method: 'GET', url: `/v1/audit/verify?chainId=${chainId}`, headers: admin,
    });
    const body = response.json() as Record<string, unknown>;

    expect(response.statusCode).toBe(200);
    expect(body.status).toBe('intact');
    expect(body.eventsChecked).toBe(4);
    expect(body.firstBreak).toBeNull();
  });

  it('always carries the tamper-EVIDENT limitation', async () => {
    // So a screenshot of a green banner cannot be presented as tamper-PROOF.
    const response = await app.inject({
      method: 'GET', url: `/v1/audit/verify?chainId=${chainId}`, headers: admin,
    });

    expect(String((response.json() as Record<string, unknown>).limitation))
      .toContain('NOT TAMPER-PROOF');
  });

  it('rejects a malformed chain id', async () => {
    const response = await app.inject({
      method: 'GET', url: `/v1/audit/verify?chainId=${encodeURIComponent("main'; DROP TABLE audit_events; --")}`,
      headers: admin,
    });

    expect(response.statusCode).toBe(400);
  });

  it('reports an empty chain as intact with zero events, not as an error', async () => {
    const response = await app.inject({
      method: 'GET', url: '/v1/audit/verify?chainId=chain_that_does_not_exist', headers: admin,
    });
    const body = response.json() as Record<string, unknown>;

    expect(response.statusCode).toBe(200);
    expect(body.totalEvents).toBe(0);
    expect(body.status).toBe('intact');
  });
});

describe('POST /v1/audit/checkpoint', () => {
  it('requires the admin key', async () => {
    const response = await app.inject({ method: 'POST', url: '/v1/audit/checkpoint', payload: {} });
    expect(response.statusCode).toBe(401);
  });

  it('anchors an intact chain and returns the signed facts', async () => {
    const response = await app.inject({
      method: 'POST', url: '/v1/audit/checkpoint', headers: admin,
      payload: { chainId, createdBy: 'route_test' },
    });
    const body = response.json() as Record<string, never>;

    expect(response.statusCode).toBe(201);
    expect((body.checkpoint as unknown as { eventCount: number }).eventCount).toBe(4);
    expect(String(body.limitation)).toContain('NOT TAMPER-PROOF');
  });

  it('refuses a SECOND checkpoint at the same position', async () => {
    // Two anchors claiming different heads at one position would make the
    // anchor ambiguous, and an ambiguous anchor anchors nothing.
    //
    // TWO EARLIER ATTEMPTS AT THIS TEST WERE WRONG, and both are worth
    // recording:
    //
    //   1. Calling the endpoint twice returned 201 twice - because creating a
    //      checkpoint APPENDS an AUDIT_CHECKPOINT_CREATED event, so the head
    //      advances and the second anchor lands at a new position. That is
    //      correct behaviour, not a bug.
    //   2. Firing two concurrent requests also returned 201 twice, because
    //      appendAuditEvent holds a per-chain advisory lock, so the second
    //      request read a head the first had already advanced. A test that
    //      depends on losing a race is a test that fails on a fast machine.
    //
    // So the collision is set up DETERMINISTICALLY: pre-insert an anchor at the
    // current head without appending anything, then ask the endpoint to anchor
    // the same position.
    const racing = `test_race_${randomBytes(6).toString('hex')}`;

    await withTransaction(pool, async (tx) => {
      await appendAuditEvent(tx, {
        eventType: 'ROUTE_TEST_EVENT', actorKind: 'system', actorId: null,
        subjectKind: 'audit', subjectId: 'race', chainId: racing, payload: { race: true },
      });
    });

    const summary = await summariseChain(pool, racing);
    const facts = {
      chainId: racing, seq: summary.headSeq!, headHash: summary.headHash!,
      eventCount: summary.eventCount, createdAt: new Date().toISOString(),
    };

    await withTransaction(pool, async (tx) => {
      await insertCheckpoint(tx, {
        ...facts,
        id: newCheckpointId(),
        signature: signCheckpoint(config.AUDIT_CHECKPOINT_SECRET!, facts),
        createdBy: 'pre_existing',
      });
    });

    const response = await app.inject({
      method: 'POST', url: '/v1/audit/checkpoint', headers: admin, payload: { chainId: racing },
    });

    expect(response.statusCode).toBe(409);
    expect((response.json() as Record<string, unknown>).error).toBe('checkpoint_exists');
  });

  it('allows a LATER checkpoint once the chain has advanced', async () => {
    // Anchoring repeatedly is the normal operating pattern - each anchor covers
    // more history than the last.
    const response = await app.inject({
      method: 'POST', url: '/v1/audit/checkpoint', headers: admin, payload: { chainId },
    });

    expect(response.statusCode).toBe(201);
  });

  it('refuses to anchor an EMPTY chain', async () => {
    const response = await app.inject({
      method: 'POST', url: '/v1/audit/checkpoint', headers: admin,
      payload: { chainId: 'chain_that_does_not_exist' },
    });

    expect(response.statusCode).toBe(409);
    expect((response.json() as Record<string, unknown>).error).toBe('chain_empty');
  });

  it('records its own creation as an audited event', async () => {
    // Who anchored the chain, and when, is itself evidence. The event lands
    // after the anchored head, so the NEXT checkpoint covers it.
    const events = await pool.query(
      `SELECT count(*)::int AS n FROM audit_events
        WHERE chain_id = $1 AND event_type = 'AUDIT_CHECKPOINT_CREATED'`,
      [chainId],
    );

    expect(events.rows[0].n).toBeGreaterThan(0);
  });

  it.skipIf(!hasOwner)('REFUSES to anchor a chain that does not verify', async () => {
    // Signing a checkpoint over a broken chain would give a forged history our
    // own signature - laundering the tampering instead of detecting it.
    const broken = `test_broken_${randomBytes(6).toString('hex')}`;

    await withTransaction(pool, async (tx) => {
      for (let index = 1; index <= 3; index += 1) {
        await appendAuditEvent(tx, {
          eventType: 'ROUTE_TEST_EVENT', actorKind: 'system', actorId: null,
          subjectKind: 'audit', subjectId: `s${index}`, chainId: broken,
          payload: { index },
        });
      }
    });

    await ownerPool.query('ALTER TABLE audit_events DISABLE TRIGGER audit_events_append_only');
    try {
      await ownerPool.query(
        `UPDATE audit_events SET actor_kind = 'admin', actor_id = 'forged'
          WHERE chain_id = $1 AND seq = (SELECT max(seq) FROM audit_events WHERE chain_id = $1)`,
        [broken],
      );
    } finally {
      await ownerPool.query('ALTER TABLE audit_events ENABLE TRIGGER audit_events_append_only');
    }

    const response = await app.inject({
      method: 'POST', url: '/v1/audit/checkpoint', headers: admin, payload: { chainId: broken },
    });

    expect(response.statusCode).toBe(409);
    expect((response.json() as Record<string, unknown>).error).toBe('chain_broken');
  });
});

describe('GET /v1/audit/events', () => {
  it('requires the admin key', async () => {
    const response = await app.inject({ method: 'GET', url: '/v1/audit/events' });
    expect(response.statusCode).toBe(401);
  });

  it('returns events newest first with their hashes', async () => {
    const response = await app.inject({
      method: 'GET', url: `/v1/audit/events?chainId=${chainId}`, headers: admin,
    });
    const body = response.json() as { events: { seq: number; hash: string; prevHash: string | null }[] };

    expect(response.statusCode).toBe(200);
    expect(body.events.length).toBeGreaterThanOrEqual(4);
    expect(body.events[0]!.seq).toBeGreaterThan(body.events[1]!.seq);
    // The hashes are exposed so anyone can recompute the chain themselves.
    expect(body.events[0]!.hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('filters by mandate', async () => {
    const response = await app.inject({
      method: 'GET', url: `/v1/audit/events?chainId=${chainId}&mandateId=mnd_weekly_groceries`,
      headers: admin,
    });
    const body = response.json() as { events: { mandateId: string | null }[] };

    expect(body.events.length).toBeGreaterThan(0);
    for (const event of body.events) expect(event.mandateId).toBe('mnd_weekly_groceries');
  });

  it('filters by event type', async () => {
    const response = await app.inject({
      method: 'GET', url: `/v1/audit/events?chainId=${chainId}&eventType=ROUTE_TEST_EVENT`,
      headers: admin,
    });
    const body = response.json() as { events: { eventType: string }[] };

    for (const event of body.events) expect(event.eventType).toBe('ROUTE_TEST_EVENT');
  });

  it('paginates by keyset, not by offset', async () => {
    // OFFSET makes deep pages progressively slower and skips or repeats rows as
    // new events are appended underneath - and this table is append-only, so
    // that happens constantly.
    const first = await app.inject({
      method: 'GET', url: `/v1/audit/events?chainId=${chainId}&limit=2`, headers: admin,
    });
    const firstBody = first.json() as { events: { seq: number }[]; nextBeforeSeq: number };

    const second = await app.inject({
      method: 'GET',
      url: `/v1/audit/events?chainId=${chainId}&limit=2&beforeSeq=${firstBody.nextBeforeSeq}`,
      headers: admin,
    });
    const secondBody = second.json() as { events: { seq: number }[] };

    const firstSeqs = firstBody.events.map((e) => e.seq);
    for (const event of secondBody.events) expect(firstSeqs).not.toContain(event.seq);
  });

  it('caps the page size regardless of what the caller asks for', async () => {
    const response = await app.inject({
      method: 'GET', url: `/v1/audit/events?chainId=${chainId}&limit=100000`, headers: admin,
    });

    expect((response.json() as { events: unknown[] }).events.length).toBeLessThanOrEqual(200);
  });
});
