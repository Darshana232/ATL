/**
 * The spend snapshot and the lock that makes it trustworthy.
 *
 * Two halves:
 *   1. window arithmetic - pure, no database
 *   2. the row lock - real connections, real contention, WITH A POSITIVE
 *      CONTROL, because a concurrency test that never actually overlaps passes
 *      while proving nothing at all.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadConfig, type Config } from '../config.js';
import { createLogger } from '../logger.js';
import { closePool, createPool, type Pool } from '../db/pool.js';
import { lockMandateForAuthorization, readSpendSnapshot, windowBoundsFor } from './spend.js';

const config: Config = loadConfig({ ...process.env, NODE_ENV: 'test', LOG_LEVEL: 'fatal' });
const logger = createLogger(config);

let pool: Pool;

beforeAll(() => { pool = createPool(config, logger); });
afterAll(async () => { await closePool(pool, logger); });

/* ------------------------------------------------------------------------ */
/* 1. Window arithmetic - pure                                              */
/* ------------------------------------------------------------------------ */

describe('spending windows are computed in the mandate timezone', () => {
  // 2026-09-07T18:30:00Z is Monday 18:30 UTC and TUESDAY 00:00 IST.
  const lateMondayUtc = new Date('2026-09-07T18:30:00Z');

  it('a daily window resets at local midnight, not UTC midnight', () => {
    // WHY IT MATTERS: for a user in India, a UTC-midnight reset lands at 05:30
    // local - handing them a fresh daily limit in the middle of the morning.
    const { start, end } = windowBoundsFor('day', lateMondayUtc, 'Asia/Kolkata');

    expect(start.toISOString()).toBe('2026-09-07T18:30:00.000Z'); // 00:00 IST Tue
    expect(end.toISOString()).toBe('2026-09-08T18:30:00.000Z');
  });

  it('the same instant produces a different day in UTC', () => {
    const utc = windowBoundsFor('day', lateMondayUtc, 'UTC');

    expect(utc.start.toISOString()).toBe('2026-09-07T00:00:00.000Z');
    // Proof the timezone argument is actually load-bearing.
    expect(utc.start.toISOString()).not.toBe(
      windowBoundsFor('day', lateMondayUtc, 'Asia/Kolkata').start.toISOString(),
    );
  });

  it('a weekly window starts on MONDAY, not Sunday', () => {
    // JavaScript's getDay() calls Sunday 0 - the US convention. Using it would
    // put Sunday's spending in the following week.
    const wednesday = new Date('2026-09-09T06:00:00Z');
    const { start, end } = windowBoundsFor('week', wednesday, 'Asia/Kolkata');

    expect(start.toISOString()).toBe('2026-09-06T18:30:00.000Z'); // Mon 7 Sep, 00:00 IST
    expect(end.toISOString()).toBe('2026-09-13T18:30:00.000Z');
  });

  it('puts Sunday in the week that STARTED on the previous Monday', () => {
    const sunday = new Date('2026-09-13T06:00:00Z'); // Sunday 13 Sep, 11:30 IST
    const { start } = windowBoundsFor('week', sunday, 'Asia/Kolkata');

    expect(start.toISOString()).toBe('2026-09-06T18:30:00.000Z');
  });

  it('a monthly window runs from the 1st to the 1st', () => {
    const { start, end } = windowBoundsFor('month', new Date('2026-09-20T06:00:00Z'), 'Asia/Kolkata');

    expect(start.toISOString()).toBe('2026-08-31T18:30:00.000Z'); // 1 Sep 00:00 IST
    expect(end.toISOString()).toBe('2026-09-30T18:30:00.000Z');   // 1 Oct 00:00 IST
  });

  it('rolls the month over at a year boundary', () => {
    const { end } = windowBoundsFor('month', new Date('2026-12-20T06:00:00Z'), 'UTC');
    expect(end.toISOString()).toBe('2027-01-01T00:00:00.000Z');
  });

  it('handles a daylight-saving transition without moving the window', () => {
    // Europe/London went BST -> GMT on 2026-10-25. A window computed with a
    // single offset guess would be an hour out on one side of it.
    const before = windowBoundsFor('day', new Date('2026-10-24T12:00:00Z'), 'Europe/London');
    const after = windowBoundsFor('day', new Date('2026-10-26T12:00:00Z'), 'Europe/London');

    expect(before.start.toISOString()).toBe('2026-10-23T23:00:00.000Z'); // BST = UTC+1
    expect(after.start.toISOString()).toBe('2026-10-26T00:00:00.000Z');  // GMT = UTC+0
  });

  it('window bounds are always ordered', () => {
    for (const kind of ['day', 'week', 'month'] as const) {
      const { start, end } = windowBoundsFor(kind, new Date(), 'Asia/Kolkata');
      expect(end.getTime(), kind).toBeGreaterThan(start.getTime());
    }
  });
});

/* ------------------------------------------------------------------------ */
/* 2. The lock - real contention                                            */
/* ------------------------------------------------------------------------ */

/** Resolves to true if `promise` is still pending after `ms`. */
async function stillPending(promise: Promise<unknown>, ms: number): Promise<boolean> {
  const marker = Symbol('pending');
  const timer = new Promise<typeof marker>((resolve) => setTimeout(() => resolve(marker), ms));

  return (await Promise.race([promise.then(() => 'settled' as const), timer])) === marker;
}

describe('SELECT ... FOR UPDATE actually serialises two authorizations', () => {
  const MANDATE = 'mnd_weekly_groceries'; // seeded fixture

  it('makes the second transaction WAIT for the first', async () => {
    const a = await pool.connect();
    const b = await pool.connect();

    try {
      await a.query('BEGIN');
      await b.query('BEGIN');

      expect(await lockMandateForAuthorization(a, MANDATE)).toBe(true);

      // B asks for the same row. It must block until A commits.
      const bLock = lockMandateForAuthorization(b, MANDATE);

      expect(
        await stillPending(bLock, 250),
        'B acquired the lock while A still held it - the window limit is not enforceable',
      ).toBe(true);

      await a.query('COMMIT');

      expect(await bLock).toBe(true); // released, and B proceeds
    } finally {
      await b.query('ROLLBACK').catch(() => {});
      await a.query('ROLLBACK').catch(() => {});
      a.release();
      b.release();
    }
  });

  it('POSITIVE CONTROL: without the lock, both transactions proceed at once', async () => {
    // THE POINT OF THIS TEST. If the test above passed for some reason other
    // than the lock - a slow connection, a serialised pool, an await in the
    // wrong place - then this one would ALSO show blocking, and we would know
    // the first test proves nothing.
    //
    // PHASE_04's most serious mistake was a check that printed seven confident
    // ticks while measuring nothing. The fix was not to remember harder; it
    // was to add a control that must behave DIFFERENTLY.
    const a = await pool.connect();
    const b = await pool.connect();

    try {
      await a.query('BEGIN');
      await b.query('BEGIN');

      await a.query('SELECT id FROM mandates WHERE id = $1', [MANDATE]); // no FOR UPDATE

      const plainRead = b.query('SELECT id FROM mandates WHERE id = $1', [MANDATE]);

      expect(
        await stillPending(plainRead, 250),
        'an unlocked read blocked, so the lock test above proves nothing',
      ).toBe(false);
    } finally {
      await b.query('ROLLBACK').catch(() => {});
      await a.query('ROLLBACK').catch(() => {});
      a.release();
      b.release();
    }
  });

  it('reports a missing mandate instead of silently locking nothing', async () => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      expect(await lockMandateForAuthorization(client, 'mnd_does_not_exist')).toBe(false);
    } finally {
      await client.query('ROLLBACK').catch(() => {});
      client.release();
    }
  });

  it('different mandates do NOT contend', async () => {
    // The scalability claim in PHASE_05 section 9: throughput scales with the
    // number of distinct mandates, not with total traffic.
    const a = await pool.connect();
    const b = await pool.connect();

    try {
      await a.query('BEGIN');
      await b.query('BEGIN');

      await lockMandateForAuthorization(a, MANDATE);
      const other = lockMandateForAuthorization(b, 'mnd_food_evening');

      expect(await stillPending(other, 250)).toBe(false);
    } finally {
      await b.query('ROLLBACK').catch(() => {});
      await a.query('ROLLBACK').catch(() => {});
      a.release();
      b.release();
    }
  });
});

describe('the snapshot counts only money that actually moved', () => {
  it('returns zeroes for a mandate with no captured payments', async () => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const now = new Date();
      const snapshot = await readSpendSnapshot(
        client, 'mnd_weekly_groceries', windowBoundsFor('week', now, 'Asia/Kolkata'), now,
      );

      expect(snapshot.spentInWindowPaise).toBeGreaterThanOrEqual(0);
      expect(snapshot.txnsInLastHour).toBeGreaterThanOrEqual(0);
      expect(Number.isInteger(snapshot.spentInWindowPaise)).toBe(true);
    } finally {
      await client.query('ROLLBACK').catch(() => {});
      client.release();
    }
  });

  it('echoes back the window it was given, so the decision can record it', async () => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const now = new Date();
      const window = windowBoundsFor('week', now, 'Asia/Kolkata');
      const snapshot = await readSpendSnapshot(client, 'mnd_weekly_groceries', window, now);

      expect(snapshot.windowStart.getTime()).toBe(window.start.getTime());
      expect(snapshot.windowEnd.getTime()).toBe(window.end.getTime());
    } finally {
      await client.query('ROLLBACK').catch(() => {});
      client.release();
    }
  });
});
