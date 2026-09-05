/**
 * Session authentication and role authorization.
 *
 * Two separate questions, deliberately separated:
 *
 *   AUTHENTICATION  who is this?          -> the session cookie
 *   AUTHORIZATION   what may they do?     -> the role
 *
 * The shared admin key conflated them: holding it meant being everything. That
 * is why `createdBy` recorded a CLAIM about who acted. After this, it records a
 * verified identity.
 *
 * THE ADMIN KEY IS NOT REMOVED, it is DEMOTED. Demo scripts and seeding still
 * need non-interactive access. When used it grants `admin`, it is logged
 * loudly, and it is recorded in the threat model as an accepted weakness -
 * which is a different thing from being quietly kept.
 */
import { createHash, timingSafeEqual } from 'node:crypto';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { Config } from '../config.js';
import type { Pool } from '../db/pool.js';
import {
  hashSessionToken, readSessionCookie, roleAtLeast, type Role,
} from '../auth/session.js';
import { findSessionByTokenHash, touchSession } from '../repositories/operator.js';

export interface Principal {
  readonly kind: 'operator' | 'shared_key';
  readonly id: string;
  readonly displayName: string;
  readonly role: Role;
  readonly sessionId: string | null;
}

declare module 'fastify' {
  interface FastifyRequest {
    principal?: Principal;
  }
}

function sharedKeyMatches(provided: string, expected: string): boolean {
  const a = createHash('sha256').update(provided, 'utf8').digest();
  const b = createHash('sha256').update(expected, 'utf8').digest();
  return timingSafeEqual(a, b);
}

export interface SessionAuthDeps {
  readonly pool: Pool;
  readonly config: Config;
  readonly now?: () => Date;
}

/**
 * Resolve the caller, if any. Never rejects - `requireRole` does that.
 *
 * Split out so a route can behave differently for an anonymous caller without
 * each route re-implementing cookie parsing.
 */
export async function resolvePrincipal(
  deps: SessionAuthDeps,
  request: FastifyRequest,
): Promise<Principal | null> {
  const now = (deps.now ?? (() => new Date()))();

  /* --- 1. Session cookie: the real path ---------------------------- */
  const token = readSessionCookie(request.headers.cookie);

  if (token !== null) {
    const session = await findSessionByTokenHash(deps.pool, hashSessionToken(token));

    if (session === null) {
      request.log.warn('session token did not match any session');
      return null;
    }

    // REVOCATION IS CHECKED ON EVERY REQUEST. This is the whole reason these
    // are sessions and not JWTs: a revoked operator stops working on their
    // NEXT call, not when a token happens to expire.
    if (session.revokedAt !== null) {
      request.log.warn({ sessionId: session.sessionId }, 'revoked session presented');
      return null;
    }

    if (session.expiresAt.getTime() <= now.getTime()) {
      request.log.info({ sessionId: session.sessionId }, 'expired session presented');
      return null;
    }

    // Suspending an OPERATOR disables every session they hold, at once, without
    // anyone revoking each one individually.
    if (session.operatorStatus !== 'active') {
      request.log.warn(
        { operatorId: session.operatorId, status: session.operatorStatus },
        'session for a non-active operator',
      );
      return null;
    }

    // Telemetry, outside any transaction. A failure here must never fail a
    // request.
    void touchSession(deps.pool, session.sessionId).catch(() => {});

    return {
      kind: 'operator', id: session.operatorId, displayName: session.displayName,
      role: session.role, sessionId: session.sessionId,
    };
  }

  /* --- 2. Shared admin key: the demoted fallback -------------------- */
  const provided = request.headers['x-atl-admin-key'];
  const expected = deps.config.ADMIN_API_KEY;

  if (typeof provided === 'string' && expected !== undefined
      && sharedKeyMatches(provided, expected)) {
    // Loud on purpose. Every use of a shared credential should be visible in
    // the logs, because it is the one path with no per-caller identity.
    request.log.warn(
      { route: request.url },
      'authenticated with the SHARED ADMIN KEY: no per-caller identity is recorded',
    );

    return {
      kind: 'shared_key', id: 'shared_admin_key',
      displayName: 'Shared admin key (no verified identity)',
      role: 'admin', sessionId: null,
    };
  }

  return null;
}

/**
 * Require a session with at least `required` role.
 *
 * 401 for "we do not know who you are", 403 for "we know, and you may not".
 * The distinction matters to a legitimate caller: one means log in, the other
 * means ask for access. It leaks only that the endpoint exists, which the
 * router already reveals.
 */
export function requireRole(deps: SessionAuthDeps, required: Role) {
  return async function roleGuard(
    request: FastifyRequest,
    reply: FastifyReply,
  ): Promise<void> {
    const principal = await resolvePrincipal(deps, request);

    if (principal === null) {
      await reply.code(401).send({
        error: 'unauthorized',
        message: 'Sign in to use this endpoint.',
        requestId: request.id,
      });
      return;
    }

    if (!roleAtLeast(principal.role, required)) {
      request.log.warn(
        { principal: principal.id, role: principal.role, required, route: request.url },
        'role check refused',
      );

      await reply.code(403).send({
        error: 'forbidden',
        message: `This action requires the ${required} role. You have ${principal.role}.`,
        requestId: request.id,
      });
      return;
    }

    request.principal = principal;
  };
}
