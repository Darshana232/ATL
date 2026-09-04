/**
 * Process entrypoint.
 *
 * Startup order matters and is deliberate:
 *   1. load .env            (nothing works without configuration)
 *   2. validate config      (fail here, loudly, if anything is wrong)
 *   3. create logger        (so every later step is observable)
 *   4. connect to Postgres and PROVE it answers
 *   5. build the HTTP app
 *   6. listen
 *   7. install signal handlers for graceful shutdown
 *
 * Step 4 is a deliberate choice: we refuse to serve traffic at all if the
 * database is unreachable at boot. An authorization service that cannot read
 * mandates must not accept requests - it would have to either fail every call
 * or, far worse, be tempted to "allow" them.
 */
import { loadEnvFile } from './env-file.js';
import { describeConfig, loadConfig } from './config.js';
import { createLogger } from './logger.js';
import { checkDatabase, closePool, createPool } from './db/pool.js';
import { buildServer } from './server.js';

/** Hard limit on how long a graceful shutdown may take before we force exit. */
const SHUTDOWN_TIMEOUT_MS = 10_000;

async function main(): Promise<void> {
  loadEnvFile();

  // Not wrapped in try/catch on purpose: if configuration is invalid there is
  // nothing sensible to do except crash with the message ConfigError produced.
  const config = loadConfig();
  const logger = createLogger(config);

  logger.info(describeConfig(config), 'starting atl-api');

  const pool = createPool(config, logger);

  try {
    await checkDatabase(pool);
    logger.info('postgres reachable');
  } catch (error) {
    logger.fatal(
      { err: error },
      'cannot reach postgres at boot - refusing to start. Is it running? `npm run db:start`',
    );
    await closePool(pool, logger);
    process.exit(1);
  }

  const app = buildServer({ config, logger, pool });

  try {
    // 127.0.0.1, not 0.0.0.0: in development the server must not be reachable
    // from other machines on the network. Phase 12 sets this per environment.
    await app.listen({ port: config.PORT, host: '127.0.0.1' });
  } catch (error) {
    logger.fatal({ err: error }, 'failed to bind port');
    await closePool(pool, logger);
    process.exit(1);
  }

  /* --- Graceful shutdown ------------------------------------------------ */
  let shuttingDown = false;

  const shutdown = async (signal: string): Promise<void> => {
    // A second Ctrl-C should not start a concurrent shutdown.
    if (shuttingDown) {
      logger.warn({ signal }, 'shutdown already in progress');
      return;
    }
    shuttingDown = true;

    logger.info({ signal }, 'shutting down gracefully');

    // Safety net: if something hangs (a stuck query, a slow client), exit
    // anyway. Deploy systems SIGKILL after their own grace period, so it is
    // better to exit deliberately than to be killed mid-write.
    const forceExit = setTimeout(() => {
      logger.error('graceful shutdown timed out, forcing exit');
      process.exit(1);
    }, SHUTDOWN_TIMEOUT_MS);
    forceExit.unref();

    try {
      // Order matters: stop accepting new work and let in-flight requests
      // finish BEFORE closing the pool. Closing the pool first would fail the
      // very requests we are trying to let complete.
      await app.close();
      await closePool(pool, logger);
      logger.info('shutdown complete');
      process.exit(0);
    } catch (error) {
      logger.error({ err: error }, 'error during shutdown');
      process.exit(1);
    }
  };

  // SIGTERM: what container platforms and `kill` send on deploy/scale-down.
  // SIGINT:  Ctrl-C in your terminal.
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));

  /**
   * Last-resort handlers. Both indicate a bug that left the process in an
   * unknown state, so we log and exit rather than continue: a payments service
   * running with corrupted internal state is more dangerous than one that is
   * simply down.
   */
  process.on('unhandledRejection', (reason) => {
    logger.fatal({ err: reason }, 'unhandled promise rejection');
    void shutdown('unhandledRejection');
  });

  process.on('uncaughtException', (error) => {
    logger.fatal({ err: error }, 'uncaught exception');
    void shutdown('uncaughtException');
  });
}

main().catch((error: unknown) => {
  // The logger may not exist yet at this point, so use console directly.
  console.error('fatal startup error:', error instanceof Error ? error.message : error);
  process.exit(1);
});
