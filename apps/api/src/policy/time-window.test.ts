import { describe, expect, it } from 'vitest';
import { TimeZoneError, isInsideWindow, localMomentIn } from './time-window.js';

describe('localMomentIn - converting UTC to a mandate timezone', () => {
  it('shifts the hour into the target zone', () => {
    // IST is UTC+5:30.
    expect(localMomentIn(new Date('2026-09-07T02:30:00Z'), 'Asia/Kolkata').hour).toBe(8);
    expect(localMomentIn(new Date('2026-09-07T14:29:00Z'), 'Asia/Kolkata').hour).toBe(19);
    expect(localMomentIn(new Date('2026-09-07T14:30:00Z'), 'Asia/Kolkata').hour).toBe(20);
  });

  it('returns hour 0 at midnight, NOT 24', () => {
    // hourCycle 'h24' returns "24" here, which would break every midnight
    // evaluation since no window can end after hour 24. Verified by probe
    // before relying on 'h23'.
    const midnightIST = new Date('2026-09-07T18:30:00Z');

    expect(localMomentIn(midnightIST, 'Asia/Kolkata').hour).toBe(0);
  });

  it('computes the WEEKDAY in the target zone too', () => {
    // The weekday genuinely changes with the zone. 18:30Z is Monday in UTC and
    // Tuesday in IST - so checking the weekday in UTC while checking the hour
    // locally would apply the wrong day's rule for 5.5 hours every day.
    const instant = new Date('2026-09-07T18:30:00Z'); // a Monday in UTC

    expect(localMomentIn(instant, 'UTC').weekday).toBe('MON');
    expect(localMomentIn(instant, 'Asia/Kolkata').weekday).toBe('TUE');
  });

  it('handles daylight saving, which a fixed offset could not', () => {
    // America/New_York is UTC-5 in January and UTC-4 in July.
    expect(localMomentIn(new Date('2026-01-15T12:00:00Z'), 'America/New_York').hour).toBe(7);
    expect(localMomentIn(new Date('2026-07-15T12:00:00Z'), 'America/New_York').hour).toBe(8);
  });

  it('covers every weekday', () => {
    const expected = ['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT'];

    for (let day = 0; day < 7; day += 1) {
      // 2026-09-06 is a Sunday.
      const instant = new Date(Date.UTC(2026, 8, 6 + day, 12, 0, 0));
      expect(localMomentIn(instant, 'UTC').weekday).toBe(expected[day]);
    }
  });

  it('throws on an unknown timezone', () => {
    // createMandateTerms already prevents this, so reaching it means a row
    // bypassed the domain constructor.
    expect(() => localMomentIn(new Date(), 'Asia/Kolkatta')).toThrow(TimeZoneError);
  });
});

describe('isInsideWindow - the end hour is EXCLUSIVE', () => {
  const weekdays = ['MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT'] as const;

  it('permits the last minute before the end hour and refuses the end hour', () => {
    // A window of 08:00-20:00 permits 19:xx and refuses 20:00. An inclusive end
    // would grant an extra hour of authority every single day.
    expect(isInsideWindow({ hour: 19, weekday: 'MON' }, 8, 20, weekdays)).toBe(true);
    expect(isInsideWindow({ hour: 20, weekday: 'MON' }, 8, 20, weekdays)).toBe(false);
  });

  it('permits exactly the start hour', () => {
    expect(isInsideWindow({ hour: 8, weekday: 'MON' }, 8, 20, weekdays)).toBe(true);
    expect(isInsideWindow({ hour: 7, weekday: 'MON' }, 8, 20, weekdays)).toBe(false);
  });

  it('treats 0-24 as the whole day, including midnight', () => {
    for (let hour = 0; hour < 24; hour += 1) {
      expect(isInsideWindow({ hour, weekday: 'MON' }, 0, 24, weekdays)).toBe(true);
    }
  });

  it('refuses a day outside the allowed weekdays even inside the hours', () => {
    expect(isInsideWindow({ hour: 12, weekday: 'SUN' }, 8, 20, weekdays)).toBe(false);
  });

  it('requires BOTH the day and the hour', () => {
    expect(isInsideWindow({ hour: 3, weekday: 'SUN' }, 8, 20, weekdays)).toBe(false);
  });
});
