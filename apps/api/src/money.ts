/**
 * Money.
 *
 * ONE RULE: all money in this system is an integer number of PAISE
 * (1 rupee = 100 paise). Never a float, anywhere, ever.
 *
 * Why: binary floating point cannot represent 0.1 exactly, so
 *   0.1 + 0.2 === 0.30000000000000004
 * In a tutorial that is a curiosity. In a payment system it becomes a ₹0.01
 * discrepancy, then a reconciliation failure, then an audit finding.
 *
 * Column names carry the unit - `amount_paise`, never `amount` - so a
 * mismatched unit is visible at the call site rather than discovered later.
 *
 * This module is PURE: no database, no clock, no I/O. That makes it trivially
 * testable, and it is the same discipline the policy engine follows in Phase 4.
 */

/**
 * An integer count of paise, as a BRANDED type.
 *
 * TypeScript is STRUCTURALLY typed: every `number` is assignable to every
 * other `number`, so nothing stops `charge(amountInRupees)` when the function
 * wanted paise. A brand adds a phantom property that exists only at compile
 * time, making `Paise` and a bare `number` incompatible - so the only way to
 * obtain one is through `toPaise()`, which validates.
 *
 * Zero runtime cost: at runtime a Paise IS just a number.
 *
 * We brand money and nothing else. Ids stay plain strings because they are
 * prefixed (`mnd_`, `usr_`), so a mix-up is visible in logs, and the database
 * already rejects a wrong-type id via CHECK constraints and foreign keys.
 * Money has no such backstop - ₹2,000 and 2,000 paise are both valid values.
 */
export type Paise = number & { readonly __brand: 'Paise' };

/** A value that cannot be represented exactly as a JS integer. */
export class MoneyPrecisionError extends Error {
  override readonly name = 'MoneyPrecisionError';
}

/** A string that is not a well-formed rupee amount. */
export class MoneyFormatError extends Error {
  override readonly name = 'MoneyFormatError';
}

/**
 * 9,007,199,254,740,991 paise ≈ ₹90,071 crore.
 *
 * Above Number.MAX_SAFE_INTEGER, integers stop being exactly representable:
 * 2^53 and 2^53 + 1 are the SAME double. Any money value beyond this point is
 * silently approximate, which is unacceptable, so we refuse it instead.
 */
export const MAX_SAFE_PAISE = Number.MAX_SAFE_INTEGER;

/**
 * Up to 15 rupee digits, optionally 1-2 decimal places.
 * Anchored at both ends: partial matches like "12abc" must fail, not parse.
 */
const RUPEE_STRING = /^(\d{1,15})(?:\.(\d{1,2}))?$/;

/**
 * The only way to obtain a `Paise` from a plain number.
 *
 * Rejects non-integers (a fraction of a paise is not a thing), negatives (a
 * refund is a different operation with its own audit trail, not a negative
 * payment), and anything above the exactly-representable range.
 */
export function toPaise(value: number): Paise {
  if (!Number.isInteger(value)) {
    throw new MoneyFormatError(
      'Paise must be a whole number; there is no smaller unit than a paisa.',
    );
  }

  if (value < 0) {
    throw new MoneyFormatError(
      'Paise must not be negative. A refund is a separate operation, not a negative amount.',
    );
  }

  if (!Number.isSafeInteger(value)) {
    throw new MoneyPrecisionError(
      `Amount exceeds the maximum exactly-representable value of ${MAX_SAFE_PAISE} paise.`,
    );
  }

  return value as Paise;
}

/**
 * Parse a rupee string into exact integer paise.
 *
 *   "4870"     ->  487000
 *   "4870.50"  ->  487050
 *   "4870.5"   ->  487050   (a single decimal means tenths)
 *   "0.01"     ->       1
 *
 * NOTE THE IMPLEMENTATION. The obvious version is Math.round(rupees * 100),
 * and it is wrong: 1.005 * 100 === 100.49999999999999, which rounds DOWN to
 * ₹1.00 instead of ₹1.01. Instead we concatenate digit strings, so no
 * floating-point arithmetic happens at any point.
 *
 * Input is a STRING on purpose. Accepting a number would mean the caller has
 * already done float arithmetic and the precision is already gone.
 */
export function paiseFromRupeeString(input: string): Paise {
  const match = RUPEE_STRING.exec(input.trim());

  if (match === null) {
    // Deliberately does not echo the input: this function will be called with
    // user- and agent-supplied values, and error messages end up in logs.
    throw new MoneyFormatError(
      'Amount must be digits with at most 2 decimal places, e.g. "4870.50". ' +
        'Negative amounts and currency symbols are not accepted.',
    );
  }

  // Safe: a successful match guarantees group 1 exists.
  const rupees = match[1] as string;
  // ".5" means 5 tenths = 50 paise, so pad on the RIGHT.
  const paisePart = (match[2] ?? '').padEnd(2, '0');

  // String concatenation, then a single integer parse. No multiplication.
  const paise = Number(rupees + paisePart);

  if (!Number.isSafeInteger(paise)) {
    throw new MoneyPrecisionError(
      `Amount exceeds the maximum exactly-representable value of ${MAX_SAFE_PAISE} paise.`,
    );
  }

  return paise as Paise;
}

/**
 * Format paise for DISPLAY ONLY.
 *
 *      487050 -> "₹4,870.50"
 *   100000000 -> "₹10,00,000.00"
 *
 * en-IN gives Indian digit grouping (lakh/crore), not thousands - ₹1,23,45,678.90
 * rather than ₹12,345,678.90. Getting this wrong makes a fintech product look
 * foreign to its own users.
 *
 * The division by 100 produces a float, which is why this is display-only and
 * its result must never re-enter a calculation. Intl rounds to 2 decimals, so
 * the displayed string is correct for every value up to MAX_SAFE_PAISE.
 */
export function formatPaise(paise: number): string {
  if (!Number.isSafeInteger(paise)) {
    throw new MoneyPrecisionError(`Cannot format a non-integer paise value.`);
  }

  return new Intl.NumberFormat('en-IN', {
    style: 'currency',
    currency: 'INR',
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(paise / 100);
}

/**
 * Parse a PostgreSQL int8 (BIGINT) value, which node-postgres hands us as a
 * STRING - deliberately, because BIGINT can hold values a JS number cannot
 * represent exactly.
 *
 * The naive fix is Number(value), and it works right up to 2^53 and then
 * starts producing plausible wrong numbers with no error. This function
 * converts that silent corruption into a loud crash.
 *
 * Also applies to COUNT(*), which Postgres returns as int8 - a convenient
 * side effect, since counts come back as real numbers instead of strings.
 */
export function parsePostgresInt8(value: string): number {
  /**
   * Reject blank input explicitly. Number('') and Number('  ') are both 0,
   * which IS a safe integer - so without this check an empty value would
   * silently become ₹0.00 instead of raising. Postgres should never hand us a
   * blank int8, but "should never" is not a guarantee, and a silent zero in a
   * money column is exactly the failure this module exists to prevent.
   *
   * Found by a test, not by inspection.
   */
  if (value.trim() === '') {
    throw new MoneyPrecisionError(
      'Received a blank value for a bigint column; refusing to interpret it as 0.',
    );
  }

  const parsed = Number(value);

  if (!Number.isSafeInteger(parsed)) {
    throw new MoneyPrecisionError(
      `PostgreSQL returned the bigint "${value}", which cannot be represented ` +
        `exactly as a JavaScript number (limit ${MAX_SAFE_PAISE}). ` +
        `Refusing to return an approximate value.`,
    );
  }

  return parsed;
}
