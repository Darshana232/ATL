/**
 * Local hour and weekday in a mandate's own timezone.
 *
 * A mandate says "08:00-20:00, Mon-Sat". That means 8am WHERE THE USER IS, but
 * every timestamp we store is UTC. This module is the conversion, and it is
 * worth its own file because two details here are easy to get wrong and both
 * were verified by probe rather than assumed:
 *
 *   1. `hourCycle: 'h24'` returns "24" at midnight, not "00". Using it would
 *      break every midnight evaluation, since no window ends after hour 24.
 *      `h23` gives 00-23.
 *
 *   2. THE WEEKDAY CHANGES WITH THE ZONE. 2026-09-07T18:30:00Z is a Monday in
 *      UTC and a TUESDAY in Asia/Kolkata. Computing the weekday in UTC while
 *      computing the hour locally would apply Monday's rule on a Tuesday.
 *
 * Intl also handles daylight saving correctly - America/New_York is UTC-5 in
 * January and UTC-4 in July - which a stored fixed offset would not.
 */
import type { Weekday } from '../domain/mandate.js';

export interface LocalMoment {
  /** 0-23 in the given timezone. */
  readonly hour: number;
  readonly weekday: Weekday;
}

/**
 * Constructing an Intl.DateTimeFormat is by far the most expensive operation in
 * the policy engine - everything else is integer comparison. There are only a
 * handful of distinct timezones in practice, so they are cached.
 *
 * Safe to cache: a formatter is immutable and stateless.
 */
const formatterCache = new Map<string, Intl.DateTimeFormat>();

function formatterFor(timezone: string): Intl.DateTimeFormat {
  const cached = formatterCache.get(timezone);
  if (cached !== undefined) return cached;

  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    weekday: 'short',
    hour: '2-digit',
    // h23, NOT h24. See the note at the top of this file.
    hourCycle: 'h23',
  });

  formatterCache.set(timezone, formatter);
  return formatter;
}

const WEEKDAY_BY_ABBREVIATION: Readonly<Record<string, Weekday>> = {
  Mon: 'MON',
  Tue: 'TUE',
  Wed: 'WED',
  Thu: 'THU',
  Fri: 'FRI',
  Sat: 'SAT',
  Sun: 'SUN',
};

export class TimeZoneError extends Error {
  override readonly name = 'TimeZoneError';
}

/**
 * The local hour and weekday of `instant`, in `timezone`.
 *
 * Throws only if the timezone is unknown - which `createMandateTerms` already
 * prevents, so reaching that means a row bypassed the domain constructor.
 */
export function localMomentIn(instant: Date, timezone: string): LocalMoment {
  let parts;
  try {
    parts = formatterFor(timezone).formatToParts(instant);
  } catch {
    throw new TimeZoneError(`"${timezone}" is not a timezone this runtime recognises`);
  }

  const byType = new Map(parts.map((part) => [part.type, part.value]));

  const hourText = byType.get('hour');
  const weekdayText = byType.get('weekday');

  if (hourText === undefined || weekdayText === undefined) {
    throw new TimeZoneError(`could not read hour and weekday for timezone "${timezone}"`);
  }

  const weekday = WEEKDAY_BY_ABBREVIATION[weekdayText];
  if (weekday === undefined) {
    throw new TimeZoneError(`unexpected weekday "${weekdayText}" for timezone "${timezone}"`);
  }

  return { hour: Number(hourText), weekday };
}

/**
 * Is `instant` inside the mandate's permitted window?
 *
 * The end hour is EXCLUSIVE: a window of 08:00-20:00 permits 19:59 and refuses
 * 20:00. That is why `windowEndHour` may be 24 - "until the end of the day".
 * The alternative (inclusive end) would grant an extra hour of authority every
 * single day, which nobody asked for.
 */
export function isInsideWindow(
  moment: LocalMoment,
  startHour: number,
  endHour: number,
  allowedWeekdays: readonly Weekday[],
): boolean {
  const dayAllowed = allowedWeekdays.includes(moment.weekday);
  const hourAllowed = moment.hour >= startHour && moment.hour < endHour;

  return dayAllowed && hourAllowed;
}
