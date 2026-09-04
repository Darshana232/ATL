/**
 * Migration runner.
 *
 * Applies `migrations/*.sql` in filename order, exactly once each, inside a
 * transaction, and records a checksum so an already-applied migration can
 * never be silently edited.
 *
 * Run with:  npm run migrate
 *
 * Design note: applied migrations are APPEND-ONLY. To change the schema you
 * add `0002_*.sql`; you never edit `0001_*.sql` after it has run anywhere.
 * That is the same discipline - and the same hash-based tamper detection - we
 * apply to the audit trail in Phase 6.
 */
import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadEnvFile } from '../env-file.js';
import { loadConfig } from '../config.js';
import { createLogger, type Logger } from '../logger.js';
import { closePool, createPool, type Pool } from './pool.js';

const MIGRATIONS_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'migrations');

/**
 * Fixed key for pg_advisory_lock. Any constant works; it just has to be the
 * same in every instance so they serialise against each other.
 */
const MIGRATION_LOCK_KEY = 84120001;

function checksum(sql: string): string {
  return createHash('sha256').update(sql, 'utf8').digest('hex');
}

/**
 * Bootstrap: the table that tracks migrations cannot itself be a migration
 * (chicken and egg), so the runner creates it directly. IF NOT EXISTS keeps
 * this safe to call on every run.
 */
async function ensureMigrationsTable(pool: Pool): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      filename    TEXT        PRIMARY KEY,
      checksum    TEXT        NOT NULL,
      applied_at  TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);
}

async function listMigrationFiles(): Promise<string[]> {
  const entries = await readdir(MIGRATIONS_DIR);
  return entries
    .filter((name) => name.endsWith('.sql'))
    // Lexicographic sort is why files are numbered 0001, 0002, ... - zero
    // padding keeps string order and numeric order identical.
    .sort((a, b) => a.localeCompare(b));
}

export async function runMigrations(pool: Pool, logger: Logger): Promise<void> {
  await ensureMigrationsTable(pool);

  /**
   * A transaction lives on ONE connection. `pool.query()` may hand out a
   * different connection per call, so BEGIN on one and COMMIT on another would
   * do nothing useful. Hence an explicit client checkout.
   */
  const client = await pool.connect();

  try {
    // Serialise concurrent migrators (e.g. two instances booting at once).
    // The lock is released automatically when this session ends.
    await client.query('SELECT pg_advisory_lock($1)', [MIGRATION_LOCK_KEY]);

    const applied = await client.query<{ filename: string; checksum: string }>(
      'SELECT filename, checksum FROM schema_migrations',
    );
    const appliedByName = new Map(applied.rows.map((row) => [row.filename, row.checksum]));

    const files = await listMigrationFiles();
    let appliedCount = 0;

    for (const filename of files) {
      const sql = await readFile(path.join(MIGRATIONS_DIR, filename), 'utf8');
      const currentChecksum = checksum(sql);
      const previousChecksum = appliedByName.get(filename);

      if (previousChecksum !== undefined) {
        /**
         * Tamper / drift detection. If the file changed after being applied,
         * the database schema and the git history no longer agree, and no
         * amount of local testing will reveal it. Refuse loudly.
         */
        if (previousChecksum !== currentChecksum) {
          throw new Error(
            `Migration ${filename} was modified after it was applied.\n` +
              `  recorded checksum: ${previousChecksum}\n` +
              `  current checksum:  ${currentChecksum}\n` +
              `Applied migrations are immutable. Add a new migration instead of editing this one.`,
          );
        }
        logger.debug({ filename }, 'migration already applied, skipping');
        continue;
      }

      logger.info({ filename }, 'applying migration');

      /**
       * All-or-nothing. Postgres supports transactional DDL, so a migration
       * that fails halfway leaves NO partial schema behind. (MySQL and Oracle
       * do not give you this, which is why migrations there are far riskier.)
       */
      try {
        await client.query('BEGIN');
        await client.query(sql);
        await client.query(
          'INSERT INTO schema_migrations (filename, checksum) VALUES ($1, $2)',
          [filename, currentChecksum],
        );
        await client.query('COMMIT');
        appliedCount += 1;
      } catch (error) {
        await client.query('ROLLBACK');
        throw new Error(
          `Migration ${filename} failed and was rolled back: ${(error as Error).message}`,
          { cause: error },
        );
      }
    }

    logger.info(
      { total: files.length, applied: appliedCount, skipped: files.length - appliedCount },
      'migrations up to date',
    );
  } finally {
    await client.query('SELECT pg_advisory_unlock($1)', [MIGRATION_LOCK_KEY]).catch(() => {
      /* lock is released on disconnect anyway; never mask the real error */
    });
    client.release();
  }
}

/**
 * CLI entrypoint. Kept at the bottom so this module can also be imported by
 * tests (which call runMigrations directly against a test database).
 *
 * Phase 12 note: `tsx` reads the .sql files straight from src/. A compiled
 * build must copy src/db/migrations into dist/db/migrations.
 */
async function main(): Promise<void> {
  loadEnvFile();
  const config = loadConfig();
  const logger = createLogger(config);
  const pool = createPool(config, logger);

  try {
    await runMigrations(pool, logger);
  } finally {
    await closePool(pool, logger);
  }
}

// import.meta.main is true only when this file is the process entrypoint,
// so importing it from a test does not kick off a migration run.
if (import.meta.main) {
  main().catch((error: unknown) => {
    // Cannot rely on the logger here - the failure may BE the config/logger.
    console.error('migration failed:', error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
