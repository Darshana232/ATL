/**
 * Console read endpoints.
 *
 * Two things matter here beyond "it returns data": nothing is readable without
 * the admin key, and a simulated payment can never be rendered as a real one.
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

const ROUTES = [
  '/v1/console/overview', '/v1/console/decisions', '/v1/console/mandates',
  '/v1/console/agents', '/v1/console/payments', '/v1/console/risk',
];

beforeAll(async () => {
  pool = createPool(config, logger);
  app = buildServer({ config, logger, pool });
  await app.ready();
});

afterAll(async () => {
  await app.close();
  await closePool(pool, logger);
});

const get = (url: string) => app.inject({ method: 'GET', url, headers: ADMIN });

describe('every console endpoint requires the admin key', () => {
  it('refuses all of them without it', async () => {
    for (const url of ROUTES) {
      const response = await app.inject({ method: 'GET', url });
      expect(response.statusCode, url).toBe(401);
    }
  });
});

describe('overview', () => {
  it('returns consistent counts from one query', async () => {
    const body = (await get('/v1/console/overview')).json() as Record<string, never>;
    const decisions = body.decisions as unknown as Record<string, number>;

    expect(decisions.total).toBe(decisions.pass + decisions.flag + decisions.block);
  });

  it('surfaces how much of the captured total is SIMULATED', async () => {
    // A dashboard must not be able to show a settled total without saying how
    // much of it is simulated.
    const body = (await get('/v1/console/overview')).json() as Record<string, never>;
    const payments = body.payments as unknown as Record<string, number>;

    expect(payments.simulatedCaptured).toBeGreaterThan(0);
    expect(String(body.simulation)).toContain('SIMULATED');
  });
});

describe('decisions', () => {
  it('lists decisions newest first', async () => {
    const body = (await get('/v1/console/decisions?limit=5')).json() as
      { decisions: { evaluatedAt: string }[] };

    expect(body.decisions.length).toBeGreaterThan(0);
    for (let i = 1; i < body.decisions.length; i += 1) {
      expect(body.decisions[i - 1]!.evaluatedAt >= body.decisions[i]!.evaluatedAt).toBe(true);
    }
  });

  it('filters by verdict', async () => {
    const body = (await get('/v1/console/decisions?verdict=BLOCK&limit=10')).json() as
      { decisions: { verdict: string }[] };

    for (const decision of body.decisions) expect(decision.verdict).toBe('BLOCK');
  });

  it('caps the page size whatever the caller asks for', async () => {
    // A dashboard that can request a million rows is a denial-of-service tool
    // with a nice font.
    const body = (await get('/v1/console/decisions?limit=999999')).json() as
      { decisions: unknown[] };

    expect(body.decisions.length).toBeLessThanOrEqual(200);
  });

  it('returns the FULL rule breakdown for one decision', async () => {
    const list = (await get('/v1/console/decisions?limit=1')).json() as
      { decisions: { id: string }[] };
    const id = list.decisions[0]!.id;

    const body = (await get(`/v1/console/decisions/${id}`)).json() as
      { evaluations: { ruleCode: string; verdict: string }[] };

    // Including the passes: "we did check the merchant" is what an auditor asks.
    expect(body.evaluations.length).toBeGreaterThanOrEqual(12);
    expect(body.evaluations.some((e) => e.verdict === 'PASS')).toBe(true);
  });

  it('answers 404 for an unknown decision', async () => {
    expect((await get('/v1/console/decisions/dec_nope')).statusCode).toBe(404);
  });
});

describe('payments are labelled honestly', () => {
  it('marks every mock payment as simulated', async () => {
    const body = (await get('/v1/console/payments?limit=50')).json() as
      { payments: { provider: string; simulated: boolean }[] };

    for (const payment of body.payments) {
      expect(payment.simulated, payment.provider).toBe(payment.provider === 'mock_upi');
    }
  });
});

describe('agents show their granted tools', () => {
  it('lists tools per agent, and no agent holds a sensitive one', async () => {
    const body = (await get('/v1/console/agents')).json() as
      { agents: { id: string; tools: string[] }[] };

    for (const agent of body.agents) {
      for (const sensitive of ['modify_mandate', 'delete_audit_event', 'export_all_users']) {
        expect(agent.tools, `${agent.id} must not hold ${sensitive}`).not.toContain(sensitive);
      }
    }
  });
});

describe('risk signals are labelled advisory', () => {
  it('says so in the response, not only in the docs', async () => {
    const body = (await get('/v1/console/risk?limit=5')).json() as Record<string, unknown>;

    expect(String(body.note)).toContain('ADVISORY');
    expect(String(body.note)).toContain('does not exist'); // AFRI
    for (const signal of body.signals as { isAdvisory: boolean }[]) {
      expect(signal.isAdvisory).toBe(true);
    }
  });
});

describe('mandates show their limits and spend', () => {
  it('returns the version in force with its allowlist', async () => {
    const body = (await get('/v1/console/mandates?limit=5')).json() as
      { mandates: { id: string; version: number; merchantIds: string[]; perTxnLimitPaise: number }[] };

    expect(body.mandates.length).toBeGreaterThan(0);
    for (const mandate of body.mandates) {
      expect(mandate.version).toBeGreaterThanOrEqual(1);
      expect(mandate.perTxnLimitPaise).toBeGreaterThan(0);
      expect(Array.isArray(mandate.merchantIds)).toBe(true);
    }
  });
});
