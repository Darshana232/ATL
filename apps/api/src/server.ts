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
import { authorizeRoutes } from './routes/authorize.js';
import { RazorpayIfscProvider, type BankLookupProvider } from './providers/bank-lookup.js';
import { MockRiskProvider, type RiskProvider } from './providers/risk.js';

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
  /**
   * Advisory risk scoring. Injected so tests can supply a provider that
   * declines to answer, proving a degraded risk service cannot change a
   * compliance verdict.
   */
  risk?: RiskProvider;
  /** Injectable clock for the authorization path. Tests drive time directly. */
  now?: () => Date;
}

/**
 * Dependencies are passed IN rather than imported and constructed here.
 *
 * That is dependency injection, and the payoff is concrete: a test can hand
 * this function a pool pointing at a throwaway database, or a deliberately
 * broken one, without touching global state or monkey-patching modules.
 */
export function buildServer({
  config,
  logger,
  pool,
  bankLookup,
  risk,
  now,
}: ServerDependencies): FastifyInstance {
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

  /* --- Raw body capture, for signature verification --------------------- */
  /**
   * Fastify parses JSON and throws the original text away. The agent signs a
   * SHA-256 of the RAW BYTES, so we must keep them: re-serialising the parsed
   * object would produce different bytes (key order, whitespace, number
   * formatting) and every signature would fail.
   *
   * Verifying against raw bytes is also the safer order. We authenticate first
   * and interpret second, so a malformed or hostile body never reaches the
   * parser on an unauthenticated request... and a parser is a far larger attack
   * surface than a hash.
   */
  app.addContentTypeParser(
    'application/json',
    { parseAs: 'string' },
    (request, rawBody, done) => {
      const text = typeof rawBody === 'string' ? rawBody : rawBody.toString('utf8');
      request.rawBody = text;

      if (text.trim() === '') {
        // An empty body is valid JSON to nobody. Signalled as a 400, with the
        // raw text still recorded so the signature check can run first.
        done(null, undefined);
        return;
      }

      try {
        done(null, JSON.parse(text) as unknown);
      } catch (error) {
        const failure = error as Error & { statusCode?: number };
        failure.statusCode = 400;
        done(failure, undefined);
      }
    },
  );

  /* --- Routes ---------------------------------------------------------- */
  app.register(healthRoutes({ pool, startedAt: Date.now() }));
  app.register(
    mandateRoutes({
      pool,
      config,
      bankLookup: bankLookup ?? new RazorpayIfscProvider(),
    }),
  );
  app.register(
    authorizeRoutes({
      pool,
      config,
      risk: risk ?? new MockRiskProvider(),
      now,
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

  app.log.debug({ env: config.NODE_ENV }, 'server built');

  return app;
}
