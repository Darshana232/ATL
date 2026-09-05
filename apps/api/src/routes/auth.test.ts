/**
 * Operator authentication and role authorization.
 *
 * Closes gaps ATL-C22 and ATL-C23, which the coverage report had been printing
 * on a screen since Phase 8. The tests that matter are the refusals.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomBytes } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { loadConfig, type Config } from '../config.js';
import { createLogger } from '../logger.js';
import { closePool, createPool, type Pool } from '../db/pool.js';
import { buildServer } from '../server.js';
import { hashPassword } from '../auth/password.js';
import { SESSION_COOKIE, hashSessionToken } from '../auth/session.js';
import { insertOperator, newOperatorId } from '../repositories/operator.js';

const config: Config = loadConfig({
  ...process.env, NODE_ENV: 'test', LOG_LEVEL: 'fatal',
  ADMIN_API_KEY: process.env.ADMIN_API_KEY ?? 'k'.repeat(48),
});
const logger = createLogger(config);

const suffix = randomBytes(4).toString('hex');
const PASSWORD = 'a-perfectly-ordinary-test-password';

const ACCOUNTS = {
  admin: { id: newOperatorId(), email: `admin.${suffix}@test.example`, role: 'admin' as const },
  compliance: { id: newOperatorId(), email: `comp.${suffix}@test.example`, role: 'compliance' as const },
  viewer: { id: newOperatorId(), email: `view.${suffix}@test.example`, role: 'viewer' as const },
  suspended: { id: newOperatorId(), email: `susp.${suffix}@test.example`, role: 'admin' as const },
};

let pool: Pool;
let app: FastifyInstance;
const cookies: Record<string, string> = {};

beforeAll(async () => {
  pool = createPool(config, logger);
  // Raised well above the production default: this file signs in dozens of
  // times, and the real limit would make the suite order-dependent.
  app = buildServer({ config, logger, pool, loginAttemptsPerMinute: 10_000 });
  await app.ready();

  const hash = await hashPassword(PASSWORD);

  for (const account of Object.values(ACCOUNTS)) {
    await insertOperator(pool, {
      id: account.id, email: account.email,
      displayName: `Test ${account.role}`, passwordHash: hash, role: account.role,
    });
  }

  await pool.query(`UPDATE operators SET status = 'suspended' WHERE id = $1`,
                   [ACCOUNTS.suspended.id]);

  for (const [name, account] of Object.entries(ACCOUNTS)) {
    if (name === 'suspended') continue;

    const response = await app.inject({
      method: 'POST', url: '/v1/auth/login',
      payload: { email: account.email, password: PASSWORD },
    });

    const setCookie = response.headers['set-cookie'];
    const raw = Array.isArray(setCookie) ? setCookie[0]! : String(setCookie);
    cookies[name] = raw.split(';')[0]!;
  }
});

afterAll(async () => {
  await app.close();
  await closePool(pool, logger);
});

const as = (role: keyof typeof cookies) => ({ cookie: cookies[role]! });

/* ------------------------------------------------------------------------ */

describe('signing in', () => {
  it('accepts the right password and returns a session cookie', async () => {
    const response = await app.inject({
      method: 'POST', url: '/v1/auth/login',
      payload: { email: ACCOUNTS.viewer.email, password: PASSWORD },
    });

    expect(response.statusCode).toBe(200);

    const setCookie = String(response.headers['set-cookie']);
    expect(setCookie).toContain(SESSION_COOKIE);
    // HttpOnly is the single most valuable attribute here: an XSS bug cannot
    // read the cookie, so it cannot steal the session.
    expect(setCookie).toContain('HttpOnly');
    // SameSite=Lax is CSRF protection for every mutating endpoint at once.
    expect(setCookie).toContain('SameSite=Lax');
  });

  it('refuses a wrong password', async () => {
    const response = await app.inject({
      method: 'POST', url: '/v1/auth/login',
      payload: { email: ACCOUNTS.viewer.email, password: 'not-the-password' },
    });

    expect(response.statusCode).toBe(401);
    expect(response.headers['set-cookie']).toBeUndefined();
  });

  it('gives the SAME answer for an unknown account as for a wrong password', async () => {
    // Otherwise the response is a user-enumeration oracle: an attacker learns
    // which addresses are registered by reading the error.
    const unknown = await app.inject({
      method: 'POST', url: '/v1/auth/login',
      payload: { email: `nobody.${suffix}@test.example`, password: PASSWORD },
    });
    const wrong = await app.inject({
      method: 'POST', url: '/v1/auth/login',
      payload: { email: ACCOUNTS.viewer.email, password: 'wrong' },
    });

    expect(unknown.statusCode).toBe(wrong.statusCode);
    expect((unknown.json() as Record<string, unknown>).message)
      .toBe((wrong.json() as Record<string, unknown>).message);
  });

  it('refuses a SUSPENDED account with the same message', async () => {
    const response = await app.inject({
      method: 'POST', url: '/v1/auth/login',
      payload: { email: ACCOUNTS.suspended.email, password: PASSWORD },
    });

    expect(response.statusCode).toBe(401);
    expect(String((response.json() as Record<string, unknown>).message))
      .toContain('do not match an active account');
  });

  it('never stores the password, and never stores the session token', async () => {
    // Two different storage decisions in one assertion, both load-bearing.
    const operator = await pool.query<{ password_hash: string }>(
      `SELECT password_hash FROM operators WHERE id = $1`, [ACCOUNTS.viewer.id],
    );
    expect(operator.rows[0]!.password_hash).not.toContain(PASSWORD);
    expect(operator.rows[0]!.password_hash).toMatch(/^scrypt\$/);

    const token = cookies.viewer!.split('=')[1]!;
    const stored = await pool.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM operator_sessions WHERE token_hash = $1`,
      [hashSessionToken(token)],
    );
    // The HASH is present...
    expect(stored.rows[0]!.n).toBe(1);

    // ...and the raw token is nowhere.
    const raw = await pool.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM operator_sessions WHERE token_hash = $1`, [token],
    );
    expect(raw.rows[0]!.n).toBe(0);
  });

  it('audits the sign-in', async () => {
    const events = await pool.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM audit_events
        WHERE event_type = 'OPERATOR_SIGNED_IN' AND actor_id = $1`,
      [ACCOUNTS.viewer.id],
    );

    expect(events.rows[0]!.n).toBeGreaterThan(0);
  });
});

describe('roles gate what an operator may do', () => {
  it('lets a viewer READ', async () => {
    const response = await app.inject({
      method: 'GET', url: '/v1/console/decisions?limit=1', headers: as('viewer'),
    });
    expect(response.statusCode).toBe(200);
  });

  it('refuses a viewer trying to MUTATE a mandate', async () => {
    const response = await app.inject({
      method: 'POST', url: '/v1/mandates', headers: as('viewer'), payload: {},
    });

    // 403, not 401: we know who they are, and they may not.
    expect(response.statusCode).toBe(403);
    expect(String((response.json() as Record<string, unknown>).message))
      .toContain('requires the admin role');
  });

  it('refuses a viewer trying to GENERATE a compliance report', async () => {
    const response = await app.inject({
      method: 'POST', url: '/v1/reports/str/generate', headers: as('viewer'), payload: {},
    });
    expect(response.statusCode).toBe(403);
  });

  it('lets compliance generate a report', async () => {
    const response = await app.inject({
      method: 'POST', url: '/v1/reports/str/generate', headers: as('compliance'), payload: {},
    });
    expect(response.statusCode).toBe(201);
  });

  it('refuses compliance trying to create an audit CHECKPOINT', async () => {
    // A checkpoint is a signed anchor later verifications are judged against.
    const response = await app.inject({
      method: 'POST', url: '/v1/audit/checkpoint', headers: as('compliance'), payload: {},
    });
    expect(response.statusCode).toBe(403);
  });

  it('lets an admin do a compliance action - roles are RANKED', async () => {
    const response = await app.inject({
      method: 'POST', url: '/v1/reports/dpdp/generate', headers: as('admin'), payload: {},
    });
    expect(response.statusCode).toBe(201);
  });

  it('records the VERIFIED identity on a generated report', async () => {
    // ATL-C22 in one assertion: `generatedBy` used to be a caller-supplied
    // string. Now it is who actually signed in.
    const response = await app.inject({
      method: 'POST', url: '/v1/reports/free-ai/generate', headers: as('compliance'),
      payload: { generatedBy: 'somebody-else-entirely' },
    });

    const id = String((response.json() as Record<string, unknown>).id);
    const stored = await pool.query<{ generated_by: string }>(
      `SELECT generated_by FROM compliance_reports WHERE id = $1`, [id],
    );

    expect(stored.rows[0]!.generated_by).toBe(ACCOUNTS.compliance.id);
    expect(stored.rows[0]!.generated_by).not.toBe('somebody-else-entirely');
  });

  it('refuses everything with no session at all', async () => {
    for (const url of ['/v1/console/overview', '/v1/reports/free-ai', '/v1/audit/verify']) {
      const response = await app.inject({ method: 'GET', url });
      expect(response.statusCode, url).toBe(401);
    }
  });

  it('CLOSES the mandate read endpoints Phase 3 left open', async () => {
    const response = await app.inject({ method: 'GET', url: '/v1/mandates/mnd_weekly_groceries' });
    expect(response.statusCode).toBe(401);
  });
});

describe('sessions are revocable immediately', () => {
  it('stops working after logout', async () => {
    // The whole reason these are sessions and not JWTs: a JWT stays valid until
    // it expires, whatever we decide in the meantime.
    const login = await app.inject({
      method: 'POST', url: '/v1/auth/login',
      payload: { email: ACCOUNTS.viewer.email, password: PASSWORD },
    });
    const cookie = String(login.headers['set-cookie']).split(';')[0]!;

    const before = await app.inject({
      method: 'GET', url: '/v1/auth/me', headers: { cookie },
    });
    expect(before.statusCode).toBe(200);

    await app.inject({ method: 'POST', url: '/v1/auth/logout', headers: { cookie } });

    const after = await app.inject({
      method: 'GET', url: '/v1/auth/me', headers: { cookie },
    });
    expect(after.statusCode).toBe(401);
  });

  it('refuses an EXPIRED session', async () => {
    // A first attempt back-dated `expires_at` with an UPDATE and was refused by
    // `operator_sessions_expiry_after_creation` - the schema doing its job: a
    // session that expires before it was created is not a state that should
    // exist, so it cannot be manufactured even by a test.
    //
    // So expiry is tested by moving the CLOCK instead, which is what actually
    // happens in production. Nine hours ahead of an eight-hour TTL.
    const login = await app.inject({
      method: 'POST', url: '/v1/auth/login',
      payload: { email: ACCOUNTS.viewer.email, password: PASSWORD },
    });
    const cookie = String(login.headers['set-cookie']).split(';')[0]!;

    const later = buildServer({
      config, logger, pool,
      now: () => new Date(Date.now() + 9 * 60 * 60 * 1000),
      loginAttemptsPerMinute: 10_000,
    });
    await later.ready();

    try {
      // Still valid on the current clock...
      expect((await app.inject({
        method: 'GET', url: '/v1/auth/me', headers: { cookie },
      })).statusCode).toBe(200);

      // ...and refused nine hours later.
      expect((await later.inject({
        method: 'GET', url: '/v1/auth/me', headers: { cookie },
      })).statusCode).toBe(401);
    } finally {
      await later.close();
    }
  });

  it('refuses a forged cookie', async () => {
    const response = await app.inject({
      method: 'GET', url: '/v1/auth/me',
      headers: { cookie: `${SESSION_COOKIE}=${randomBytes(32).toString('base64url')}` },
    });
    expect(response.statusCode).toBe(401);
  });

  it('an admin can revoke every session an operator holds', async () => {
    const login = await app.inject({
      method: 'POST', url: '/v1/auth/login',
      payload: { email: ACCOUNTS.compliance.email, password: PASSWORD },
    });
    const cookie = String(login.headers['set-cookie']).split(';')[0]!;

    const revoke = await app.inject({
      method: 'POST',
      url: `/v1/auth/operators/${ACCOUNTS.compliance.id}/revoke-sessions`,
      headers: as('admin'), payload: {},
    });
    expect(revoke.statusCode).toBe(200);

    const after = await app.inject({
      method: 'GET', url: '/v1/auth/me', headers: { cookie },
    });
    expect(after.statusCode).toBe(401);
  });
});

describe('the shared admin key still works, and says so loudly', () => {
  it('grants admin, but reports that no identity was verified', async () => {
    // Not removed - demoted. Demo scripts and seeding need non-interactive
    // access, and pretending otherwise would mean deleting the tooling.
    const response = await app.inject({
      method: 'GET', url: '/v1/auth/me',
      headers: { 'x-atl-admin-key': config.ADMIN_API_KEY! },
    });
    const body = response.json() as Record<string, unknown>;

    expect(response.statusCode).toBe(200);
    expect(body.role).toBe('admin');
    expect(body.kind).toBe('shared_key');
    expect(body.verifiedIdentity).toBe(false);
  });

  it('refuses a wrong shared key', async () => {
    const response = await app.inject({
      method: 'GET', url: '/v1/auth/me',
      headers: { 'x-atl-admin-key': 'not-the-key' },
    });
    expect(response.statusCode).toBe(401);
  });
});

describe('login is rate limited', () => {
  it('returns 429 with Retry-After after too many attempts', async () => {
    // By IP, because there is no identity yet - which is exactly when
    // credential stuffing happens.
    //
    // A SEPARATE SERVER with a low limit, so this test proves limiting without
    // the limiter interfering with every other test in the file.
    const tight = buildServer({ config, logger, pool, loginAttemptsPerMinute: 3 });
    await tight.ready();

    try {
      const email = `flood.${randomBytes(4).toString('hex')}@test.example`;
      let limited: Awaited<ReturnType<typeof tight.inject>> | null = null;

      for (let attempt = 0; attempt < 6; attempt += 1) {
        const response = await tight.inject({
          method: 'POST', url: '/v1/auth/login',
          payload: { email, password: 'wrong' },
        });
        if (response.statusCode === 429) { limited = response; break; }
      }

      expect(limited, 'login should be rate limited').not.toBeNull();
      // Retry-After is how a well-behaved client learns to back off instead of
      // hammering. Omitting it turns a limited client into a busy one.
      expect(limited!.headers['retry-after']).toBeDefined();
      expect(Number(limited!.headers['retry-after'])).toBeGreaterThan(0);
    } finally {
      await tight.close();
    }
  });

  it('locks an account after repeated failures, and says so differently', async () => {
    // Lockout is a genuine trade: it stops online guessing, and it lets someone
    // who knows an email address deny that person access on purpose. Fifteen
    // minutes makes the denial an annoyance rather than an outage.
    const email = `lock.${randomBytes(4).toString('hex')}@test.example`;
    const id = newOperatorId();
    await insertOperator(pool, {
      id, email, displayName: 'Lock test',
      passwordHash: await hashPassword(PASSWORD), role: 'viewer',
    });

    for (let attempt = 0; attempt < 5; attempt += 1) {
      await app.inject({
        method: 'POST', url: '/v1/auth/login', payload: { email, password: 'wrong' },
      });
    }

    // Even the CORRECT password is refused while locked.
    const response = await app.inject({
      method: 'POST', url: '/v1/auth/login', payload: { email, password: PASSWORD },
    });

    expect(response.statusCode).toBe(429);
    expect((response.json() as Record<string, unknown>).error).toBe('account_locked');
  });
});
