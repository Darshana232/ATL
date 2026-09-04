/**
 * Builds the Fastify application.
 *
 * Deliberately separate from src/index.ts (the entrypoint): buildServer()
 * creates an app but never listens on a port, so tests can drive it in-process
 * via app.inject() with no network, no port conflicts, and no cleanup races.
 */
import { randomUUID } from 'node:crypto';
import Fastify, {
  type FastifyBaseLogger,
  type FastifyError,
  type FastifyInstance,
} from 'fastify';
import type { Config } from './config.js';
import type { Logger } from './logger.js';
import type { Pool } from './db/pool.js';
import { healthRoutes } from './routes/health.js';
import { mandateRoutes } from './routes/mandates.js';
import { RazorpayIfscProvider, type BankLookupProvider } from './providers/bank-lookup.js';

export interface ServerDependencies {
  config: Config;
  logger: Logger;
  pool: Pool;
  /**
   * Injected so tests use a static, offline provider. Defaults to the real
   * Razorpay IFSC API, which is only ever called on the cold path
   * (mandate creation) - never during authorization. See ADR-0013.
   */
  bankLookup?: BankLookupProvider;
}

/**
 * Dependencies are passed IN rather than imported and constructed here.
 *
 * That is dependency injection, and the payoff is concrete: a test can hand
 * this function a pool pointing at a throwaway database, or a deliberately
 * broken one, without touching global state or monkey-patching modules.
 */
export function buildServer({ config, logger, pool, bankLookup }: ServerDependencies): FastifyInstance {
  const app = Fastify({
    /**
     * Fastify 5 takes an existing pino instance as `loggerInstance`.
     *
     * The `as FastifyBaseLogger` is an upcast, not a workaround. Fastify's
     * types are generic over the logger, so handing it a concrete pino.Logger
     * specialises the ENTIRE FastifyInstance type - and then it no longer
     * matches `FastifyInstance` with default generics, breaking inference for
     * plugins and handlers too. pino's Logger is stricter than
     * FastifyBaseLogger (it additionally requires msgPrefix), so widening to
     * the framework's own interface is safe and keeps every other type aligned.
     */
    loggerInstance: logger as FastifyBaseLogger,

    /**
     * Every request gets an ID, and it is attached to every log line that
     * request produces. This is what makes "show me everything that happened
     * during this one payment authorisation" a single query instead of an
     * archaeology project. From Phase 5 it also becomes part of the audit
     * record, tying a decision back to the request that caused it.
     */
    genReqId: () => randomUUID(),

    /**
     * Trust a caller-supplied request id when present, so a trace started in
     * the dashboard or the agent runtime continues through this service
     * instead of restarting here.
     */
    requestIdHeader: 'x-request-id',

    /**
     * 1 MiB. Default is 1 MiB too, but stating it makes the limit a decision
     * rather than an accident: an unbounded body limit is a trivial
     * memory-exhaustion denial of service.
     */
    bodyLimit: 1_048_576,
  });

  /* --- Routes ---------------------------------------------------------- */
  app.register(healthRoutes({ pool, startedAt: Date.now() }));
  app.register(
    mandateRoutes({
      pool,
      config,
      bankLookup: bankLookup ?? new RazorpayIfscProvider(),
    }),
  );

  /* --- 404 -------------------------------------------------------------- */
  app.setNotFoundHandler((request, reply) => {
    return reply.code(404).send({
      error: 'not_found',
      message: `Route ${request.method} ${request.url} does not exist.`,
      requestId: request.id,
    });
  });

  /* --- Errors ----------------------------------------------------------- */
  // `error` is annotated explicitly rather than inferred: Fastify's overloads
  // will silently fall back to `unknown` here, which then hides real mistakes.
  app.setErrorHandler((error: FastifyError, request, reply) => {
    const statusCode = error.statusCode ?? 500;

    // Client errors (4xx) are the caller's problem and safe to describe.
    // Server errors (5xx) are OUR problem and must not be described: stack
    // traces and driver messages leak file paths, library versions, SQL and
    // sometimes credentials. Log the detail, return an opaque response plus
    // the requestId so a human can quote it and we can find the real error.
    if (statusCode >= 500) {
      request.log.error({ err: error }, 'unhandled error');

      return reply.code(statusCode).send({
        error: 'internal_error',
        message: 'An unexpected error occurred.',
        requestId: request.id,
      });
    }

    request.log.warn({ err: error, statusCode }, 'request rejected');

    return reply.code(statusCode).send({
      error: error.code ?? 'bad_request',
      message: error.message,
      requestId: request.id,
    });
  });

  // Referenced so the parameter is not unused; config drives real behaviour
  // from Phase 5 onward (rate limits, CORS origins, voucher signing).
  app.log.debug({ env: config.NODE_ENV }, 'server built');

  return app;
}
