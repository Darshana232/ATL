import { describe, expect, it } from 'vitest';
import {
  MAX_SAFE_PAISE,
  MoneyFormatError,
  MoneyPrecisionError,
  formatPaise,
  paiseFromRupeeString,
  parsePostgresInt8,
} from './money.js';

describe('paiseFromRupeeString - exact parsing', () => {
  it('parses whole rupees', () => {
    expect(paiseFromRupeeString('4870')).toBe(487000);
    expect(paiseFromRupeeString('0')).toBe(0);
    expect(paiseFromRupeeString('1')).toBe(100);
  });

  it('parses two decimal places', () => {
    expect(paiseFromRupeeString('4870.50')).toBe(487050);
    expect(paiseFromRupeeString('0.01')).toBe(1);
    expect(paiseFromRupeeString('99.99')).toBe(9999);
  });

  it('treats a single decimal digit as tenths, not hundredths', () => {
    // ".5" is 50 paise, not 5. Padding on the wrong side would make every
    // such amount 10x too small.
    expect(paiseFromRupeeString('4870.5')).toBe(487050);
    expect(paiseFromRupeeString('0.1')).toBe(10);
  });

  it('tolerates surrounding whitespace', () => {
    expect(paiseFromRupeeString('  1200.75  ')).toBe(120075);
  });

  it('avoids the float multiplication bug', () => {
    // The bug we are avoiding, asserted so this test documents the reason:
    // 1.005 * 100 evaluates to 100.49999999999999, so Math.round gives 100
    // (₹1.00) when the correct answer is 101 (₹1.01).
    expect(Math.round(1.005 * 100)).toBe(100); // wrong, and silently so

    // Our parser never multiplies, so it cannot drift. A third decimal is
    // rejected outright rather than silently rounded - losing a paise the
    // caller believed they sent is not an acceptable default.
    expect(() => paiseFromRupeeString('1.005')).toThrow(MoneyFormatError);

    expect(paiseFromRupeeString('1.00')).toBe(100);
    expect(paiseFromRupeeString('1.01')).toBe(101);
  });

  it('is exact across many values where float math drifts', () => {
    for (let rupees = 0; rupees < 200; rupees += 1) {
      for (const cents of ['00', '01', '05', '10', '33', '99']) {
        const parsed = paiseFromRupeeString(`${rupees}.${cents}`);
        expect(parsed).toBe(rupees * 100 + Number(cents));
        expect(Number.isInteger(parsed)).toBe(true);
      }
    }
  });
});

describe('paiseFromRupeeString - rejects bad input', () => {
  it('rejects more than two decimal places', () => {
    // Paise is the smallest unit; a third decimal is not representable and
    // silently rounding it would lose money the caller believed they sent.
    expect(() => paiseFromRupeeString('4870.123')).toThrow(MoneyFormatError);
  });

  it('rejects negative amounts', () => {
    // A negative payment is a refund, which is a different operation with a
    // different audit trail. It must never arrive as a negative amount.
    expect(() => paiseFromRupeeString('-500')).toThrow(MoneyFormatError);
  });

  it('rejects currency symbols, separators and units', () => {
    for (const bad of ['₹4870', '4,870', '4870 INR', 'Rs.4870']) {
      expect(() => paiseFromRupeeString(bad)).toThrow(MoneyFormatError);
    }
  });

  it('rejects non-numeric and malformed strings', () => {
    for (const bad of ['', '   ', 'abc', '1.2.3', '1e3', '.5', '5.', 'NaN', 'Infinity']) {
      expect(() => paiseFromRupeeString(bad)).toThrow(MoneyFormatError);
    }
  });

  it('does NOT partially parse a string with trailing junk', () => {
    // An unanchored regex would read "12" out of "12abc" and charge ₹12.
    expect(() => paiseFromRupeeString('12abc')).toThrow(MoneyFormatError);
  });

  it('SECURITY: the format error does not echo the supplied value', () => {
    // Amounts arrive from users and agents, and this message reaches logs.
    let message = '';
    try {
      paiseFromRupeeString('secret-looking-garbage');
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).not.toContain('secret-looking-garbage');
  });
});

describe('formatPaise - display', () => {
  it('formats with two decimals', () => {
    expect(formatPaise(487050)).toBe('₹4,870.50');
    expect(formatPaise(1)).toBe('₹0.01');
    expect(formatPaise(100)).toBe('₹1.00');
  });

  it('uses Indian digit grouping, not thousands grouping', () => {
    // ₹10,00,000.00 (lakh), NOT ₹1,000,000.00. Getting this wrong makes an
    // Indian fintech product look foreign to its own users.
    expect(formatPaise(100000000)).toBe('₹10,00,000.00');
    expect(formatPaise(1234567890)).toBe('₹1,23,45,678.90');
  });

  it('round-trips with the parser', () => {
    for (const input of ['0.01', '1.00', '4870.50', '100000.00']) {
      const paise = paiseFromRupeeString(input);
      const formatted = formatPaise(paise);
      // Strip the symbol and separators to compare numerically.
      const back = formatted.replace(/[₹,]/g, '');
      expect(paiseFromRupeeString(back)).toBe(paise);
    }
  });

  it('refuses to format a non-integer', () => {
    expect(() => formatPaise(1.5)).toThrow(MoneyPrecisionError);
  });
});

describe('parsePostgresInt8 - guards against silent precision loss', () => {
  it('parses normal bigint strings', () => {
    // node-postgres hands us int8 as a STRING, not a number.
    expect(parsePostgresInt8('0')).toBe(0);
    expect(parsePostgresInt8('487050')).toBe(487050);
    expect(parsePostgresInt8(String(MAX_SAFE_PAISE))).toBe(MAX_SAFE_PAISE);
  });

  it('throws rather than returning an approximate value', () => {
    // 9007199254740993 is not representable: it and 9007199254740992 are the
    // same double. Number() returns the wrong value with no error - which is
    // exactly the failure this guard exists to prevent.
    expect(Number('9007199254740993')).toBe(9007199254740992); // silent corruption
    expect(() => parsePostgresInt8('9007199254740993')).toThrow(MoneyPrecisionError);
  });

  it('throws on values far beyond the safe range', () => {
    expect(() => parsePostgresInt8('9223372036854775807')).toThrow(MoneyPrecisionError);
  });

  it('throws on non-numeric input', () => {
    for (const bad of ['', 'abc', 'NaN', '1.5']) {
      expect(() => parsePostgresInt8(bad)).toThrow(MoneyPrecisionError);
    }
  });

  it('handles negative bigints (row ids and offsets, not money)', () => {
    expect(parsePostgresInt8('-42')).toBe(-42);
  });
});
