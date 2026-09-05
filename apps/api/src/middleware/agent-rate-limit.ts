/**
 * The agent rate limiter, as a shared singleton.
 *
 * ONE limiter instance across both agent endpoints, so an agent cannot get a
 * fresh budget by alternating between `/v1/authorize` and `/v1/payments`. The
 * limit is on the AGENT, not on the route.
 *
 * It is created at module load, which makes it process-wide. That is the
 * correct scope for a limiter and the wrong scope for a test fixture, so tests
 * construct their own `RateLimiter` rather than importing this one.
 */
import type { FastifyRequest } from 'fastify';
import { rateLimit } from './rate-limit.js';

/**
 * 120 requests per minute per agent - two per second sustained.
 *
 * A shopping agent making a handful of authorizations per order is nowhere near
 * it. A runaway loop hits it in half a second, which is the point: the limit
 * exists to bound a broken or hostile agent, not to shape normal traffic.
 */
export const AGENT_RATE_LIMIT = { max: 120, windowMs: 60_000 } as const;

export function agentRateLimit(now: () => Date) {
  return rateLimit(
    {
      name: 'agent',
      max: AGENT_RATE_LIMIT.max,
      windowMs: AGENT_RATE_LIMIT.windowMs,
      /**
       * Keyed on the AUTHENTICATED agent id, which is only present because
       * this guard runs after signature verification.
       *
       * Returning null when there is no agent is correct rather than lax: an
       * unauthenticated request has already been rejected with a 401, so there
       * is nothing left to limit.
       */
      keyOf: (request: FastifyRequest) => request.atlAgent?.agentId ?? null,
    },
    () => now().getTime(),
  );
}
