/**
 * Report endpoints, including the review workflow that STOPS at
 * READY_FOR_FILING.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { loadConfig, type Config } from '../config.js';
import { createLogger } from '../logger.js';
import { closePool, createPool, type Pool } from '../db/pool.js';
import { buildServer } from '../server.js';
import { ADMIN_KEY_HEADER } from '../middleware/admin-auth.js';

const config: Config = loadConfig({
  ...process.env, NODE_ENV: 'test', LOG_LEVEL: 'fatal',
  ADMIN_API_KEY: process.env.ADMIN_API_KEY ?? 'k'.repeat(48),
});
const ADMIN = { [ADMIN_KEY_HEADER]: config.ADMIN_API_KEY! };
const logger = createLogger(config);

let pool: Pool;
let app: FastifyInstance;

beforeAll(async () => {
  pool = createPool(config, logger);
  app = buildServer({ config, logger, pool });
  await app.ready();
});

afterAll(async () => {
  await app.close();
  await closePool(pool, logger);
});

const get = (url: string, headers = ADMIN) => app.inject({ method: 'GET', url, headers });

describe('report endpoints require the admin key', () => {
  it('refuses every report without it', async () => {
    for (const url of ['/v1/reports/free-ai', '/v1/reports/str', '/v1/reports/dpdp', '/v1/reports']) {
      const response = await app.inject({ method: 'GET', url });
      expect(response.statusCode, url).toBe(401);
    }
  });
});

describe('GET /v1/reports/free-ai', () => {
  it('returns coverage as a ratio with named gaps', async () => {
    const response = await get('/v1/reports/free-ai');
    const body = response.json() as Record<string, unknown>;

    expect(response.statusCode).toBe(200);
    expect(String(body.coverage)).toMatch(/^\d+\/\d+$/);
    expect((body.gaps as string[]).length).toBeGreaterThan(0);
  });

  it('never returns a percentage or the word "compliant"', async () => {
    const text = (await get('/v1/reports/free-ai')).body;

    expect(text).not.toMatch(/\d+(\.\d+)?%/);
    expect(text.toLowerCase()).not.toMatch(/\bcompliant\b/);
  });
});

describe('GET /v1/reports/str', () => {
  it('is a DRAFT carrying the FIU-IND caveat', async () => {
    const body = (await get('/v1/reports/str')).json() as Record<string, unknown>;

    expect(body.status).toBe('DRAFT');
    expect(String(body.caveat)).toContain('NOT a filed');
  });
});

describe('GET /v1/reports/dpdp', () => {
  it('returns the register with its gaps', async () => {
    const body = (await get('/v1/reports/dpdp')).json() as Record<string, unknown>;

    expect((body.records as unknown[]).length).toBeGreaterThan(0);
    expect((body.gaps as unknown[]).length).toBeGreaterThan(0);
  });
});

describe('generating and reviewing a report', () => {
  let reportId = '';

  it('stores a generated report with a body hash', async () => {
    // Stored rather than recomputed: re-running the query next month gives a
    // different answer, and a compliance report is a statement about a moment.
    const response = await app.inject({
      method: 'POST', url: '/v1/reports/str/generate', headers: ADMIN,
      payload: { generatedBy: 'compliance@example.com' },
    });
    const body = response.json() as Record<string, unknown>;

    expect(response.statusCode).toBe(201);
    expect(String(body.bodyHash)).toMatch(/^[0-9a-f]{64}$/);
    expect(body.status).toBe('DRAFT');

    reportId = String(body.id);
  });

  it('audits the generation', async () => {
    // "Who ran the compliance report, and when" is a question an auditor asks
    // about the auditor.
    const events = await pool.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM audit_events
        WHERE subject_id = $1 AND event_type = 'REPORT_GENERATED'`, [reportId],
    );

    expect(events.rows[0]!.n).toBe(1);
  });

  it('lists it', async () => {
    const body = (await get('/v1/reports?kind=str_draft')).json() as
      { reports: { id: string }[] };

    expect(body.reports.some((report) => report.id === reportId)).toBe(true);
  });

  it('refuses to skip DRAFT -> READY_FOR_FILING', async () => {
    // A report cannot become ready for filing without passing through review.
    // Enforced by a database trigger, not by the route.
    const response = await app.inject({
      method: 'POST', url: `/v1/reports/detail/${reportId}/review`, headers: ADMIN,
      payload: { status: 'READY_FOR_FILING', reviewedBy: 'officer@example.com' },
    });

    expect(response.statusCode).toBe(409);
    expect((response.json() as Record<string, unknown>).error).toBe('illegal_transition');
  });

  it('advances DRAFT -> UNDER_REVIEW -> READY_FOR_FILING', async () => {
    const first = await app.inject({
      method: 'POST', url: `/v1/reports/detail/${reportId}/review`, headers: ADMIN,
      payload: { status: 'UNDER_REVIEW', reviewedBy: 'officer@example.com' },
    });
    expect(first.statusCode).toBe(200);

    const second = await app.inject({
      method: 'POST', url: `/v1/reports/detail/${reportId}/review`, headers: ADMIN,
      payload: {
        status: 'READY_FOR_FILING', reviewedBy: 'officer@example.com',
        note: 'Two candidates warrant filing.',
      },
    });

    expect(second.statusCode).toBe(200);
    // READY_FOR_FILING is terminal for us and says so.
    expect(String((second.json() as Record<string, unknown>).note))
      .toContain('does NOT file');
  });

  it('has no path to a "filed" status at all', async () => {
    // The schema has no such value, so no code path can set one.
    const response = await app.inject({
      method: 'POST', url: `/v1/reports/detail/${reportId}/review`, headers: ADMIN,
      payload: { status: 'FILED', reviewedBy: 'officer@example.com' },
    });

    expect(response.statusCode).toBe(400);

    const allowed = await pool.query<{ def: string }>(
      `SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint
        WHERE conname = 'compliance_reports_status_valid'`,
    );
    expect(allowed.rows[0]!.def.toLowerCase()).not.toContain("'filed'");
  });

  it('refuses to change a stored report body', async () => {
    // The body is what a reviewer approved. Editing it afterwards would let an
    // approved report say something nobody approved.
    const error = await pool
      .query(`UPDATE compliance_reports SET body_hash = $2 WHERE id = $1`,
             [reportId, 'a'.repeat(64)])
      .then(() => null)
      .catch((e: unknown) => e as { code?: string });

    expect(error?.code).toBe('ATL02');
  });

  it('answers 404 for an unknown report', async () => {
    const response = await get('/v1/reports/detail/rpt_nope');
    expect(response.statusCode).toBe(404);
  });

  it('rejects an unknown report kind', async () => {
    const response = await app.inject({
      method: 'POST', url: '/v1/reports/nonsense/generate', headers: ADMIN, payload: {},
    });
    expect(response.statusCode).toBe(404);
  });
});
