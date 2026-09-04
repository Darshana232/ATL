/**
 * Admin authentication for the Phase 3 mandate endpoints.
 *
 * THIS IS NOT THE REAL AUTHENTICATION MODEL. Phase 5 replaces it with
 * per-agent Ed25519 request signatures, and Phase 9 adds per-user sessions
 * with RBAC.
 *
 * It exists because the alternative was shipping unauthenticated
 * mandate-MUTATION endpoints until Phase 5 - and normalising that default is
 * how systems end up exposed. A shared key is weak, but "weak" and "absent"
 * are different categories.
 */
import { createHash, timingSafeEqual } from 'node:crypto';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { Config } from '../config.js';

export const ADMIN_KEY_HEADER = 'x-atl-admin-key';

/**
 * Compare two secrets without leaking their contents through timing.
 *
 * `a === b` on strings short-circuits at the first differing character, so how
 * long it takes reveals how many leading characters were correct - and an
 * attacker can recover a key one character at a time. timingSafeEqual always
 * examines every byte.
 *
 * Both sides are SHA-256'd first for two reasons: timingSafeEqual THROWS on a
 * length mismatch (which would itself leak the key's length), and hashing
 * guarantees equal-length inputs.
 */
function secretsMatch(provided: string, expected: string): boolean {
  const providedDigest = createHash('sha256').update(provided, 'utf8').digest();
  const expectedDigest = createHash('sha256').update(expected, 'utf8').digest();

  return timingSafeEqual(providedDigest, expectedDigest);
}

/**
 * Fastify preHandler enforcing the admin key.
 *
 * When no key is configured (development only - production config refuses to
 * boot without one) the guard logs a warning and allows the request, so a
 * newcomer running `npm run dev` is not blocked by a credential they have not
 * created yet.
 */
export function requireAdminKey(config: Config) {
  return async function adminKeyGuard(
    request: FastifyRequest,
    reply: FastifyReply,
  ): Promise<void> {
    const expected = config.ADMIN_API_KEY;

    if (expected === undefined) {
      request.log.warn(
        { route: request.url },
        'ADMIN_API_KEY is not set: admin endpoints are UNPROTECTED. Development only.',
      );
      return;
    }

    const provided = request.headers[ADMIN_KEY_HEADER];

    if (typeof provided !== 'string' || !secretsMatch(provided, expected)) {
      // Deliberately uninformative: "missing" and "wrong" produce the same
      // response, so probing cannot distinguish them. The requestId still lets
      // an operator find the attempt in the logs.
      request.log.warn(
        { route: request.url, hasHeader: typeof provided === 'string' },
        'admin endpoint rejected: bad or missing admin key',
      );

      await reply.code(401).send({
        error: 'unauthorized',
        message: `A valid ${ADMIN_KEY_HEADER} header is required.`,
        requestId: request.id,
      });
    }
  };
}
