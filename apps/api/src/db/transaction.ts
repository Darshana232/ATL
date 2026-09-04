/**
 * Transaction helper.
 *
 * Every mandate mutation writes BOTH the domain rows and an audit event, and
 * they must land together. An audit event describing a mandate that was never
 * created - or a mandate with no audit event - is worse than either alone,
 * because the trail would then be lying rather than merely incomplete.
 */
import type pg from 'pg';
import type { Pool } from './pool.js';

export async function withTransaction<T>(
  pool: Pool,
  body: (client: pg.PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();

  try {
    await client.query('BEGIN');
    const result = await body(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    // Never mask the original failure with a rollback failure.
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}
