/**
 * Operator authentication: sign in, sign out, who am I.
 */
import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import type { Config } from '../config.js';
import type { Pool } from '../db/pool.js';
import { withTransaction } from '../db/transaction.js';
import { appendAuditEvent } from '../audit/writer.js';
import { burnPasswordTime, verifyPassword } from '../auth/password.js';
import {
  clearedSessionCookie, mintSessionToken, sessionCookie,
} from '../auth/session.js';
import { rateLimit, clientIp } from '../middleware/rate-limit.js';
import { requireRole, resolvePrincipal } from '../middleware/session-auth.js';
import {
  findOperatorByEmail, insertSession, newSessionId,
  recordFailedLogin, recordSuccessfulLogin, revokeAllSessions, revokeSession,
} from '../repositories/operator.js';

export interface AuthRoutesDeps {
  readonly pool: Pool;
  readonly config: Config;
  readonly now?: () => Date;
  /**
   * Login attempts per minute per IP.
   *
   * Injected rather than hardcoded, for the same reason the clock and the
   * providers are: a test suite that signs in dozens of times would otherwise
   * exhaust the real budget and fail in an ORDER-DEPENDENT way - which is how
   * a rate limiter turns a test suite into a coin flip.
   *
   * The production value is the default, so forgetting to pass it is safe.
   * A dedicated test constructs a server with a low limit to prove limiting
   * actually happens.
   */
  readonly loginAttemptsPerMinute?: number;
}

/** Ten a minute. A human signing in ten times a minute is already unusual. */
export const DEFAULT_LOGIN_ATTEMPTS_PER_MINUTE = 10;

const loginSchema = z.strictObject({
  email: z.string().trim().min(3).max(320),
  password: z.string().min(1).max(1024),
});

export function authRoutes(deps: AuthRoutesDeps): FastifyPluginAsync {
  const { pool, config } = deps;
  const clock = deps.now ?? (() => new Date());
  const secureCookies = config.NODE_ENV === 'production';

  return async function register(app) {
    /* ------------------------------------------------------------------
     * POST /v1/auth/login
     * ---------------------------------------------------------------- */
    app.post(
      '/v1/auth/login',
      {
        // BY IP, because there is no identity yet - which is precisely when
        // credential stuffing happens. Tight, because a human logging in ten
        // times a minute is already unusual.
        preHandler: rateLimit({
          name: 'login',
          max: deps.loginAttemptsPerMinute ?? DEFAULT_LOGIN_ATTEMPTS_PER_MINUTE,
          windowMs: 60_000,
          keyOf: clientIp,
        }),
      },
      async (request, reply) => {
        const parsed = loginSchema.safeParse(request.body);

        if (!parsed.success) {
          return reply.code(400).send({
            error: 'validation_failed',
            message: 'Email and password are required.',
            requestId: request.id,
          });
        }

        const { email, password } = parsed.data;
        const now = clock();
        const operator = await findOperatorByEmail(pool, email);

        /*
         * USER ENUMERATION, and the fix.
         *
         * If "no such user" returned instantly and "wrong password" took 200 ms,
         * the response time alone would tell an attacker which addresses are
         * registered. So the no-user path does the SAME scrypt work against a
         * dummy hash, and both paths return the same message.
         */
        if (operator === null) {
          await burnPasswordTime(password);
          request.log.warn({ ip: request.ip }, 'login attempt for an unknown account');
          return reply.code(401).send({
            error: 'invalid_credentials',
            message: 'That email and password do not match an active account.',
            requestId: request.id,
          });
        }

        if (operator.lockedUntil !== null && operator.lockedUntil.getTime() > now.getTime()) {
          request.log.warn({ operatorId: operator.id }, 'login attempt on a locked account');
          return reply.code(429).send({
            error: 'account_locked',
            message: 'Too many failed attempts. Try again shortly.',
            requestId: request.id,
          });
        }

        const ok = await verifyPassword(password, operator.passwordHash);

        if (!ok || operator.status !== 'active') {
          await recordFailedLogin(pool, operator.id);

          // A suspended account and a wrong password give the SAME answer, so
          // an attacker cannot learn an account's state by guessing at it.
          request.log.warn(
            { operatorId: operator.id, status: operator.status, passwordOk: ok },
            'failed login',
          );

          return reply.code(401).send({
            error: 'invalid_credentials',
            message: 'That email and password do not match an active account.',
            requestId: request.id,
          });
        }

        const session = mintSessionToken(now);
        const sessionId = newSessionId();

        await withTransaction(pool, async (tx) => {
          await insertSession(tx, {
            id: sessionId, operatorId: operator.id,
            tokenHash: session.tokenHash, expiresAt: session.expiresAt,
            ip: request.ip,
            userAgent: typeof request.headers['user-agent'] === 'string'
              ? request.headers['user-agent'] : null,
          });

          await recordSuccessfulLogin(tx, operator.id);

          // Sign-in is an audited event: "who had access, and when" is a
          // question every security review asks.
          await appendAuditEvent(tx, {
            eventType: 'OPERATOR_SIGNED_IN',
            actorKind: 'admin', actorId: operator.id,
            subjectKind: 'user', subjectId: operator.id,
            requestId: String(request.id),
            payload: {
              operatorId: operator.id, sessionId, role: operator.role,
              // The IP is recorded as a hint for investigation, never used for
              // authorization: it is attacker-controllable behind a proxy.
              ip: request.ip,
              at: now.toISOString(),
            },
          });
        });

        return reply
          .header('set-cookie', sessionCookie(session.token, session.expiresAt, secureCookies))
          .code(200)
          .send({
            operator: {
              id: operator.id, email: operator.email,
              displayName: operator.displayName, role: operator.role,
            },
            expiresAt: session.expiresAt.toISOString(),
          });
      },
    );

    /* ------------------------------------------------------------------
     * POST /v1/auth/logout
     * ---------------------------------------------------------------- */
    app.post('/v1/auth/logout', async (request, reply) => {
      const principal = await resolvePrincipal({ pool, config, now: clock }, request);

      if (principal?.sessionId != null) {
        await withTransaction(pool, async (tx) => {
          await revokeSession(tx, principal.sessionId!, 'signed out');
          await appendAuditEvent(tx, {
            eventType: 'OPERATOR_SIGNED_OUT',
            actorKind: 'admin', actorId: principal.id,
            subjectKind: 'user', subjectId: principal.id,
            requestId: String(request.id),
            payload: { operatorId: principal.id, sessionId: principal.sessionId },
          });
        });
      }

      // The cookie is cleared whether or not there was a session. Logging out
      // must always leave the browser in a signed-out state.
      return reply
        .header('set-cookie', clearedSessionCookie(secureCookies))
        .code(200)
        .send({ signedOut: true });
    });

    /* ------------------------------------------------------------------
     * GET /v1/auth/me
     * ---------------------------------------------------------------- */
    app.get('/v1/auth/me', async (request, reply) => {
      const principal = await resolvePrincipal({ pool, config, now: clock }, request);

      if (principal === null) {
        return reply.code(401).send({
          error: 'unauthorized', message: 'Not signed in.', requestId: request.id,
        });
      }

      return reply.code(200).send({
        id: principal.id, displayName: principal.displayName,
        role: principal.role, kind: principal.kind,
        // Surfaced so the console can warn: a shared key means no verified
        // identity is being recorded for anything this caller does.
        verifiedIdentity: principal.kind === 'operator',
      });
    });

    /* ------------------------------------------------------------------
     * POST /v1/auth/operators/:id/revoke-sessions  (admin)
     * ---------------------------------------------------------------- */
    app.post<{ Params: { id: string } }>(
      '/v1/auth/operators/:id/revoke-sessions',
      { preHandler: requireRole({ pool, config, now: clock }, 'admin') },
      async (request, reply) => {
        const actor = request.principal!;
        let revoked = 0;

        await withTransaction(pool, async (tx) => {
          revoked = await revokeAllSessions(
            tx, request.params.id, `revoked by ${actor.id}`,
          );

          await appendAuditEvent(tx, {
            eventType: 'OPERATOR_SESSIONS_REVOKED',
            actorKind: 'admin', actorId: actor.id,
            subjectKind: 'user', subjectId: request.params.id,
            requestId: String(request.id),
            payload: { operatorId: request.params.id, revoked, by: actor.id },
          });
        });

        return reply.code(200).send({ operatorId: request.params.id, revoked });
      },
    );
  };
}
