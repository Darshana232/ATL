/**
 * Health endpoints.
 *
 * Two endpoints, because "is the process alive?" and "can this instance serve
 * traffic?" are different questions with different consequences:
 *
 *   GET /v1/health/live   liveness  - touches nothing, always 200 if we can
 *                                     answer at all. Failing => RESTART ME.
 *   GET /v1/health        readiness - queries Postgres. Failing => STOP
 *                                     SENDING ME TRAFFIC (but do not kill me;
 *                                     the database may recover).
 *
 * Conflating the two causes a well-known outage: the database hiccups, every
 * instance fails its health check, the orchestrator restarts them all
 * simultaneously, and a database that was about to recover now faces a
 * thundering herd of reconnecting instances.
 */
import type { FastifyInstance, FastifyPluginAsync } from 'fastify';
import { checkDatabase, type Pool } from '../db/pool.js';

/** Bumped manually for now; Phase 12 wires this to the git commit SHA. */
const SERVICE_VERSION = '0.1.0';

interface HealthDependencies {
  pool: Pool;
  /** Process start time, from Date.now(), used to report uptime. */
  startedAt: number;
}

export function healthRoutes({ pool, startedAt }: HealthDependencies): FastifyPluginAsync {
  return async (app: FastifyInstance): Promise<void> => {
    /* --- Liveness ------------------------------------------------------- */
    app.get('/v1/health/live', async () => ({
      status: 'ok',
      version: SERVICE_VERSION,
      uptimeSeconds: Math.floor((Date.now() - startedAt) / 1000),
    }));

    /* --- Readiness ------------------------------------------------------ */
    app.get('/v1/health', async (request, reply) => {
      // hrtime.bigint() is a monotonic clock: unlike Date.now() it cannot jump
      // backwards when the system clock is adjusted (NTP, DST), so it is the
      // correct tool for measuring a duration.
      const start = process.hrtime.bigint();
      let database: 'ok' | 'error' = 'ok';

      try {
        await checkDatabase(pool);
      } catch (error) {
        database = 'error';
        /**
         * SECURITY: log the real reason, return only the marker.
         *
         * A message like 'password authentication failed for user "atl"' tells
         * an unauthenticated caller our username, our driver, and that this
         * endpoint reaches an internal database. That is information
         * disclosure, and health endpoints are usually the least protected
         * route in a service.
         */
        request.log.error({ err: error }, 'readiness check failed: database unreachable');
      }

      const latencyMs = Number(process.hrtime.bigint() - start) / 1_000_000;
      const isReady = database === 'ok';

      /**
       * The status CODE is the contract that load balancers and orchestrators
       * read - they do not parse our JSON body. Returning 200 with
       * {"status":"degraded"} would keep traffic flowing to a broken instance.
       */
      return reply.code(isReady ? 200 : 503).send({
        status: isReady ? 'ok' : 'degraded',
        version: SERVICE_VERSION,
        uptimeSeconds: Math.floor((Date.now() - startedAt) / 1000),
        checks: {
          database,
          databaseLatencyMs: Math.round(latencyMs * 100) / 100,
        },
      });
    });
  };
}
