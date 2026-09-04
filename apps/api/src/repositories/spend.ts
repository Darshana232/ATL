/**
 * The spend snapshot, and the lock that makes it trustworthy.
 *
 * PHASE_04 recorded this as debt: the policy engine is pure, so it TRUSTS the
 * snapshot it is handed. That makes the window limit only as accurate as
 * whoever computed it. This module is where the limit stops being arithmetic
 * and becomes enforcement.
 *
 * THE BUG THIS PREVENTS (time-of-check to time-of-use):
 *
 *   mandate: ₹5,000 per week, ₹4,500 already spent  -> ₹500 of headroom
 *
 *   request A  reads "₹4,500 spent"  ─┐
 *   request B  reads "₹4,500 spent"  ─┘  both read the same number
 *   request A  ₹400 fits             ─┐
 *   request B  ₹400 fits             ─┘  both compute PASS
 *   -> ₹5,300 spent against a ₹5,000 limit
 *
 * Nothing is wrong with either evaluation. The engine is correct both times.
 * The defect is that the two evaluations were allowed to overlap.
 */
import type pg from 'pg';
import { toPaise, type Paise } from '../money.js';
import type { WindowKind } from '../domain/mandate.js';
import type { SpendSnapshot } from '../policy/types.js';

/** Velocity counts the trailing hour, not a calendar hour. */
const ONE_HOUR_MS = 60 * 60 * 1000;

/**
 * Take an exclusive lock on the mandate row.
 *
 * `SELECT ... FOR UPDATE` makes a second transaction asking for the same row
 * WAIT until this one commits or rolls back. Authorizations for one mandate
 * therefore serialise; authorizations for different mandates never contend.
 *
 * WHY THE MANDATE ROW: it is the object being contended over, it is guaranteed
 * to exist by a foreign key, and locking it is understandable by anyone reading
 * the code.
 *
 * REJECTED - SERIALIZABLE isolation: correct, but it surfaces conflicts at
 * COMMIT as 40001 errors and pushes a retry loop into every caller. Retry loops
 * are where concurrency bugs live.
 *
 * REJECTED - an advisory lock: works, but invents a lock object when a real row
 * already exists.
 *
 * Returns false when the mandate does not exist, so the caller can answer 404
 * rather than proceeding with a lock it never took.
 */
export async function lockMandateForAuthorization(
  txClient: pg.PoolClient,
  mandateId: string,
): Promise<boolean> {
  const result = await txClient.query(`SELECT id FROM mandates WHERE id = $1 FOR UPDATE`, [
    mandateId,
  ]);

  return result.rowCount === 1;
}

export interface SpendWindow {
  readonly start: Date;
  readonly end: Date;
}

/**
 * The UTC offset of `timezone` at `instant`, in milliseconds.
 *
 * There is no direct API for this in JavaScript. The trick: format the instant
 * in the target zone, read the wall-clock fields back, and interpret THOSE as
 * if they were UTC. The difference is the offset. It handles daylight saving
 * automatically, because Intl already does.
 */
function offsetMsAt(timezone: string, instant: Date): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    hourCycle: 'h23',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).formatToParts(instant);

  const at = new Map(parts.map((p) => [p.type, Number(p.value)]));

  const asIfUtc = Date.UTC(
    at.get('year') ?? 1970,
    (at.get('month') ?? 1) - 1,
    at.get('day') ?? 1,
    at.get('hour') ?? 0,
    at.get('minute') ?? 0,
    at.get('second') ?? 0,
  );

  return asIfUtc - instant.getTime();
}

/** The local calendar date of `instant`, in `timezone`. */
function localDateParts(timezone: string, instant: Date): { y: number; m: number; d: number; weekday: number } {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    year: 'numeric', month: '2-digit', day: '2-digit', weekday: 'short',
  }).formatToParts(instant);

  const byType = new Map(parts.map((p) => [p.type, p.value]));
  const order = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

  return {
    y: Number(byType.get('year')),
    m: Number(byType.get('month')),
    d: Number(byType.get('day')),
    weekday: order.indexOf(byType.get('weekday') ?? 'Sun'),
  };
}

/**
 * The UTC instant of local midnight on a given local calendar date.
 *
 * Applied twice on purpose. The first pass uses the offset at the guessed
 * instant, which can be the WRONG side of a daylight-saving transition; the
 * second pass corrects it. Two iterations always converge for real-world zones,
 * whose transitions are at most an hour or two.
 *
 * (India never observes DST, so this matters for a mandate in, say,
 * Europe/London - and getting it wrong there would silently move a spending
 * window by an hour twice a year.)
 */
function utcInstantOfLocalMidnight(timezone: string, y: number, m: number, d: number): Date {
  const naive = Date.UTC(y, m - 1, d, 0, 0, 0);
  let guess = new Date(naive - offsetMsAt(timezone, new Date(naive)));
  guess = new Date(naive - offsetMsAt(timezone, guess));
  return guess;
}

/**
 * The spending window in force at `now`, expressed in the mandate's own zone.
 *
 * A "day" is the user's day. For someone in Asia/Kolkata a daily limit resets
 * at midnight IST, not at midnight UTC - which is 05:30 local and would hand
 * them a fresh limit in the middle of the evening.
 *
 * `week` starts on MONDAY. That is the ISO-8601 convention and the ordinary
 * reading of "this week" in India; JavaScript's own `getDay()` treats Sunday as
 * 0, which is the US convention and would put Sunday's spending in the wrong
 * week. Stated here because the default is a trap.
 */
export function windowBoundsFor(kind: WindowKind, now: Date, timezone: string): SpendWindow {
  const { y, m, d, weekday } = localDateParts(timezone, now);

  switch (kind) {
    case 'day': {
      const start = utcInstantOfLocalMidnight(timezone, y, m, d);
      const next = new Date(Date.UTC(y, m - 1, d + 1));
      const nextParts = { y: next.getUTCFullYear(), m: next.getUTCMonth() + 1, d: next.getUTCDate() };
      return { start, end: utcInstantOfLocalMidnight(timezone, nextParts.y, nextParts.m, nextParts.d) };
    }
    case 'week': {
      // Sunday (0) is 6 days after Monday, not 1 day before it.
      const daysSinceMonday = (weekday + 6) % 7;
      const monday = new Date(Date.UTC(y, m - 1, d - daysSinceMonday));
      const nextMonday = new Date(Date.UTC(y, m - 1, d - daysSinceMonday + 7));

      return {
        start: utcInstantOfLocalMidnight(timezone, monday.getUTCFullYear(), monday.getUTCMonth() + 1, monday.getUTCDate()),
        end: utcInstantOfLocalMidnight(timezone, nextMonday.getUTCFullYear(), nextMonday.getUTCMonth() + 1, nextMonday.getUTCDate()),
      };
    }
    case 'month': {
      const firstNext = new Date(Date.UTC(y, m, 1));
      return {
        start: utcInstantOfLocalMidnight(timezone, y, m, 1),
        end: utcInstantOfLocalMidnight(timezone, firstNext.getUTCFullYear(), firstNext.getUTCMonth() + 1, 1),
      };
    }
    default: {
      const unreachable: never = kind;
      throw new Error(`unhandled window kind: ${String(unreachable)}`);
    }
  }
}

/**
 * Read what this mandate has already spent, and how fast.
 *
 * MUST be called inside the transaction that holds the mandate row lock -
 * otherwise it is a snapshot of a number that can change one millisecond later,
 * which is the exact bug documented at the top of this file.
 *
 * ONLY `captured` payments count. A payment in `created` or `authorized` has not
 * moved money and may yet fail; counting it would deny a user headroom they
 * still have. A `failed` one certainly must not count.
 *
 * ONE QUERY for both numbers. They are read at the same instant from the same
 * snapshot, so they cannot disagree with each other.
 */
export async function readSpendSnapshot(
  txClient: pg.PoolClient,
  mandateId: string,
  window: SpendWindow,
  now: Date,
): Promise<SpendSnapshot> {
  const result = await txClient.query<{ spent: string | null; recent: string }>(
    `SELECT
        COALESCE(SUM(amount_paise) FILTER (
          WHERE captured_at >= $2 AND captured_at < $3
        ), 0)::bigint AS spent,
        COUNT(*) FILTER (WHERE captured_at >= $4)::bigint AS recent
       FROM payments
      WHERE mandate_id = $1
        AND status = 'captured'`,
    [mandateId, window.start, window.end, new Date(now.getTime() - ONE_HOUR_MS)],
  );

  const row = result.rows[0];

  // db/types.ts registers an int8 parser that returns a number and THROWS
  // rather than silently losing precision past 2^53, so these are numbers.
  const spent = Number(row?.spent ?? 0);
  const recent = Number(row?.recent ?? 0);

  return {
    windowStart: window.start,
    windowEnd: window.end,
    spentInWindowPaise: toPaise(spent) as Paise,
    txnsInLastHour: recent,
  };
}
