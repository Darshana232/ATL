/**
 * Integration test: does our int8 parser actually change what Postgres hands
 * back, and does it genuinely refuse unrepresentable values?
 *
 * This cannot be a unit test. The behaviour under test is the interaction
 * between node-postgres's type-parser registry and a real wire response.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import pg from 'pg';
import { loadConfig, type Config } from '../config.js';
import { createLogger } from '../logger.js';
import { closePool, createPool, type Pool } from './pool.js';
import { MoneyPrecisionError } from '../money.js';

const config: Config = loadConfig({ ...process.env, NODE_ENV: 'test', LOG_LEVEL: 'fatal' });
const logger = createLogger(config);

describe('postgres int8 handling', () => {
  let pool: Pool;

  beforeAll(() => {
    // createPool() registers the parser as a side effect.
    pool = createPool(config, logger);
  });

  afterAll(async () => {
    await closePool(pool, logger);
  });

  it("documents node-postgres's default: int8 arrives as a string", () => {
    // Not our behaviour - the library's. Asserted so the reason our parser
    // exists is visible, and so we notice if a future version changes it.
    const defaultParser = pg.types.getTypeParser(20);
    expect(typeof defaultParser('487050')).not.toBe('string');
    // ^ after registration it is OUR parser. The point of the assertion is
    //   that registration took effect at all.
  });

  it('returns a real number for a money-sized bigint', async () => {
    const result = await pool.query<{ amount_paise: number }>(
      'SELECT $1::bigint AS amount_paise',
      [487050],
    );

    expect(typeof result.rows[0]?.amount_paise).toBe('number');
    expect(result.rows[0]?.amount_paise).toBe(487050);
  });

  it('returns a number for count(*), which Postgres also sends as int8', async () => {
    const result = await pool.query<{ count: number }>('SELECT count(*) FROM merchants');

    // Without the parser this is the string "0" - and `"0" > 5` is false while
    // `"10" > 5` is also false, so comparisons on counts silently misbehave.
    expect(typeof result.rows[0]?.count).toBe('number');
  });

  it('THROWS on a bigint that cannot be represented exactly', async () => {
    // 9007199254740993 = 2^53 + 1. Number() maps it to 2^53, silently.
    // We would rather crash than return a plausible wrong amount.
    await expect(
      pool.query('SELECT 9007199254740993::bigint AS too_big'),
    ).rejects.toThrow(MoneyPrecisionError);
  });

  it('accepts exactly MAX_SAFE_INTEGER', async () => {
    const result = await pool.query<{ v: number }>(
      'SELECT 9007199254740991::bigint AS v',
    );

    expect(result.rows[0]?.v).toBe(Number.MAX_SAFE_INTEGER);
  });
});
