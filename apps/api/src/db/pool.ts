/**
 * PostgreSQL connection pool.
 *
 * Opening a connection costs a TCP handshake plus authentication (~5-15ms).
 * A pool keeps a small number of connections open and lends them out, so that
 * cost is paid once at startup rather than on every request.
 */
import pg from 'pg';
import type { Config } from '../config.js';
import type { Logger } from '../logger.js';
import { registerPostgresTypeParsers } from './types.js';

export type Pool = pg.Pool;

/**
 * Maximum connections THIS process will hold.
 *
 * Important and widely misunderstood: pool size is a cluster-wide budget, not
 * a per-process preference. PostgreSQL enforces a hard `max_connections`
 * (default 100). Ten API instances with `max: 100` each would demand 1000
 * connections; Postgres refuses the excess - including your monitoring and
 * your psql session, exactly when you need them.
 *
 * Budget: instances x max <= max_connections - headroom.
 * With max: 10 we can run ~8 instances against a default Postgres safely.
 */
const MAX_CONNECTIONS = 10;

export function createPool(config: Config, logger: Logger): Pool {
  /**
   * Must happen before any query runs. Installed here rather than in each
   * entrypoint so it cannot be forgotten: no pool exists without it.
   */
  registerPostgresTypeParsers();

  const pool = new pg.Pool({
    connectionString: config.DATABASE_URL,

    max: MAX_CONNECTIONS,

    /** Return idle connections to the OS after 30s rather than holding them. */
    idleTimeoutMillis: 30_000,

    /**
     * Fail fast if no connection is available within 5s.
     *
     * Without this, a request waits FOREVER for a connection. Under load,
     * requests queue, memory climbs, and the process eventually dies holding
     * thousands of open sockets. A clear 503 is a far better failure than an
     * unbounded hang - this is backpressure.
     */
    connectionTimeoutMillis: 5_000,

    /**
     * Shows up in `SELECT application_name FROM pg_stat_activity`, so when the
     * database is busy you can tell which service is responsible.
     */
    application_name: 'atl-api',
  });

  /**
   * CRITICAL: idle connections can die on their own - Postgres restarts, a
   * network blip, an idle timeout on the server side. In Node, an unhandled
   * 'error' event CRASHES THE PROCESS. Three lines here stop the API dying
   * because the database blinked; the pool simply opens a fresh connection.
   */
  pool.on('error', (error) => {
    logger.error({ err: error }, 'idle postgres client errored (pool will recover)');
  });

  return pool;
}

/**
 * Prove the database is genuinely reachable and answering queries.
 *
 * `SELECT 1` is the cheapest possible real query: it does no table access, no
 * planning of substance, and touches no data - but it fails if the connection
 * is dead, credentials are wrong, or the database is not accepting queries.
 * "The process is running" and "the database works" are different claims.
 */
export async function checkDatabase(pool: Pool): Promise<void> {
  await pool.query('SELECT 1');
}

/**
 * Close the pool during shutdown.
 *
 * Lets in-flight queries finish and closes sockets cleanly, instead of leaving
 * Postgres to time out abandoned connections. Called from the SIGTERM handler:
 * graceful shutdown is what makes a zero-downtime deploy possible.
 */
export async function closePool(pool: Pool, logger: Logger): Promise<void> {
  try {
    await pool.end();
    logger.info('postgres pool closed');
  } catch (error) {
    logger.error({ err: error }, 'error while closing postgres pool');
  }
}
