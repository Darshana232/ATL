/**
 * Integration tests for the health endpoints.
 *
 * These talk to the REAL local PostgreSQL, because the thing under test is
 * precisely "can this service reach its database". Mocking the database here
 * would test our mock rather than our system.
 *
 * Requests go through app.inject(), which processes a synthetic HTTP request
 * in-process: real router, real hooks, real handler, real serialisation, but
 * no port binding and therefore no port conflicts or network flakiness.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadConfig, type Config } from '../config.js';
import { createLogger } from '../logger.js';
import { closePool, createPool, type Pool } from '../db/pool.js';
import { buildServer } from '../server.js';

/** Quiet logger: tests should print test output, not application logs. */
const testConfig: Config = loadConfig({ ...process.env, NODE_ENV: 'test', LOG_LEVEL: 'fatal' });
const logger = createLogger(testConfig);

describe('health endpoints (database reachable)', () => {
  let pool: Pool;
  let app: ReturnType<typeof buildServer>;

  beforeAll(async () => {
    pool = createPool(testConfig, logger);
    app = buildServer({ config: testConfig, logger, pool });
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
    await closePool(pool, logger);
  });

  it('liveness returns 200 without touching the database', async () => {
    const response = await app.inject({ method: 'GET', url: '/v1/health/live' });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ status: 'ok', version: expect.any(String) });
  });

  it('readiness returns 200 and reports the database as ok', async () => {
    const response = await app.inject({ method: 'GET', url: '/v1/health' });

    expect(response.statusCode).toBe(200);

    const body = response.json();
    expect(body.status).toBe('ok');
    expect(body.checks.database).toBe('ok');
    // Proves the check actually executed a query rather than returning a
    // hardcoded 'ok'.
    expect(typeof body.checks.databaseLatencyMs).toBe('number');
    expect(body.checks.databaseLatencyMs).toBeGreaterThanOrEqual(0);
  });

  it('unknown routes return a structured 404 carrying a requestId', async () => {
    const response = await app.inject({ method: 'GET', url: '/v1/does-not-exist' });

    expect(response.statusCode).toBe(404);
    expect(response.json()).toMatchObject({ error: 'not_found' });
    // Every response is traceable back to its log lines.
    expect(response.json().requestId).toBeTruthy();
  });

  it('propagates a caller-supplied x-request-id instead of generating a new one', async () => {
    // Keeps one trace intact across dashboard -> api -> agent runtime.
    const response = await app.inject({
      method: 'GET',
      url: '/v1/does-not-exist',
      headers: { 'x-request-id': 'trace-from-caller-123' },
    });

    expect(response.json().requestId).toBe('trace-from-caller-123');
  });
});

describe('health endpoints (database unreachable)', () => {
  let brokenPool: Pool;
  let app: ReturnType<typeof buildServer>;

  beforeAll(async () => {
    /**
     * Port 9 is the standard "discard" port and refuses TCP connections, so
     * this pool can never connect. We are testing our DEGRADED path, which is
     * the path that actually runs during an incident and therefore the one
     * most worth having a test for.
     */
    const brokenConfig: Config = loadConfig({
      ...process.env,
      NODE_ENV: 'test',
      LOG_LEVEL: 'fatal',
      DATABASE_URL: 'postgres://nobody:wrongpassword@127.0.0.1:9/nonexistent',
    });

    brokenPool = createPool(brokenConfig, logger);
    app = buildServer({ config: brokenConfig, logger, pool: brokenPool });
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
    await closePool(brokenPool, logger);
  });

  it('liveness still returns 200 - the process is fine, its dependency is not', async () => {
    // This distinction is the whole point of splitting the endpoints: an
    // orchestrator must NOT restart these instances. Restarting every instance
    // because the database blinked turns a brief outage into a thundering herd
    // against a database that was about to recover.
    const response = await app.inject({ method: 'GET', url: '/v1/health/live' });

    expect(response.statusCode).toBe(200);
  });

  it('readiness returns 503 so load balancers stop sending traffic here', async () => {
    const response = await app.inject({ method: 'GET', url: '/v1/health' });

    // The status CODE is the contract. A 200 with {"status":"degraded"} would
    // keep routing traffic to a broken instance.
    expect(response.statusCode).toBe(503);
    expect(response.json()).toMatchObject({
      status: 'degraded',
      checks: { database: 'error' },
    });
  });

  it('SECURITY: the failure response leaks no connection details', async () => {
    /**
     * Health endpoints are typically the least protected route in a service.
     * A driver error such as 'password authentication failed for user
     * "nobody"' would tell an unauthenticated caller our username, our driver
     * and that this endpoint reaches an internal database.
     *
     * If this test ever fails, we have an information-disclosure bug.
     */
    const response = await app.inject({ method: 'GET', url: '/v1/health' });
    const raw = response.body;

    expect(raw).not.toMatch(/ECONNREFUSED/i);
    expect(raw).not.toMatch(/password/i);
    expect(raw).not.toMatch(/nobody/i);
    expect(raw).not.toMatch(/127\.0\.0\.1/);
    expect(raw).not.toMatch(/nonexistent/i);
    // No stack traces, ever.
    expect(raw).not.toMatch(/at .*\.(js|ts):\d+/);
  });
});
