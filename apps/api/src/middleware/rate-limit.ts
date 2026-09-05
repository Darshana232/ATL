/**
 * Rate limiting.
 *
 * Closes gap ATL-C23, which the coverage report prints on a screen: "a valid
 * credential can currently make unlimited requests."
 *
 * FIXED WINDOW, IN PROCESS, and both of those are limitations worth stating
 * rather than discovering:
 *
 *   FIXED WINDOW, ANCHORED AT THE FIRST REQUEST - not at a wall-clock
 *   boundary. A window opens when a request arrives with no live window, and
 *   closes windowMs later. The consequence is a burst: requests late in one
 *   window plus requests immediately after it resets can briefly exceed the
 *   nominal rate. Measured in rate-limit.test.ts, where an earlier version of
 *   that test asserted the WRONG burst shape and failed. A sliding window or
 *   token bucket smooths it; we accept it because these limits bound ABUSE
 *   rather than shape traffic, and twice a bound is still a bound.
 *
 *   IN PROCESS does not survive horizontal scaling: two API instances mean two
 *   counters and twice the effective limit. Correct at one instance. A shared
 *   store (Redis) or edge limiting is the fix, and this is recorded in the
 *   threat model rather than pretended away.
 *
 * LIMITS ARE PER IDENTITY WHEREVER AN IDENTITY EXISTS. An IP is a poor
 * identity: agents behind one NAT would share a budget, and an attacker with a
 * /64 of IPv6 has effectively unlimited ones. Login is the exception, because
 * there is no identity yet - which is exactly when credential stuffing happens.
 */
import type { FastifyReply, FastifyRequest } from 'fastify';

interface Window {
  count: number;
  resetAt: number;
}

export interface RateLimitOptions {
  readonly max: number;
  readonly windowMs: number;
  /** What we are counting against. Return null to skip limiting entirely. */
  readonly keyOf: (request: FastifyRequest) => string | null;
  readonly name: string;
}

/**
 * A limiter instance.
 *
 * Exported as a class so tests can create an isolated one. A module-level
 * singleton would leak counts between test files and produce the worst kind of
 * failure: one that depends on execution order.
 */
export class RateLimiter {
  private readonly windows = new Map<string, Window>();
  /** Bounds memory: an attacker cycling keys must not grow this forever. */
  private readonly maxKeys = 10_000;

  constructor(private readonly options: RateLimitOptions) {}

  /** Returns null when allowed, or the seconds to wait when limited. */
  check(key: string, now: number): number | null {
    const existing = this.windows.get(key);

    if (existing === undefined || now >= existing.resetAt) {
      if (this.windows.size >= this.maxKeys) this.evict(now);
      this.windows.set(key, { count: 1, resetAt: now + this.options.windowMs });
      return null;
    }

    existing.count += 1;
    if (existing.count <= this.options.max) return null;

    return Math.max(1, Math.ceil((existing.resetAt - now) / 1000));
  }

  /** Drop expired windows; if that is not enough, drop the oldest. */
  private evict(now: number): void {
    for (const [key, window] of this.windows) {
      if (now >= window.resetAt) this.windows.delete(key);
    }

    while (this.windows.size >= this.maxKeys) {
      const oldest = this.windows.keys().next();
      if (oldest.done === true) break;
      this.windows.delete(oldest.value);
    }
  }

  get size(): number { return this.windows.size; }
}

export function rateLimit(options: RateLimitOptions, now: () => number = Date.now) {
  const limiter = new RateLimiter(options);

  return async function rateLimitGuard(
    request: FastifyRequest,
    reply: FastifyReply,
  ): Promise<void> {
    const key = options.keyOf(request);
    if (key === null) return;

    const retryAfter = limiter.check(`${options.name}:${key}`, now());
    if (retryAfter === null) return;

    request.log.warn(
      { limiter: options.name, key, route: request.url },
      'rate limit exceeded',
    );

    // Retry-After is not decoration: it is how a well-behaved client learns to
    // back off instead of hammering. Omitting it turns a limited client into a
    // busy one.
    await reply
      .header('retry-after', String(retryAfter))
      .code(429)
      .send({
        error: 'rate_limited',
        message: `Too many requests. Retry after ${retryAfter} seconds.`,
        retryAfterSeconds: retryAfter,
        requestId: request.id,
      });
  };
}

/** The client's address, for the one case where no identity exists yet. */
export function clientIp(request: FastifyRequest): string {
  return request.ip;
}
