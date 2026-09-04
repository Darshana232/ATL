/**
 * Bank branch lookup by IFSC.
 *
 * THE ONLY LIVE EXTERNAL API CALL IN THE SYSTEM, and it is confined to a cold
 * path by ADR-0013:
 *
 *   allowed  seed-time fixture generation; mandate CREATION, where a human is
 *            present, the call is optional, and failure is tolerable
 *   NEVER    anywhere on the authorization path
 *
 * The reason for that prohibition is worth stating plainly: if a compliance
 * verdict depended on a third party's uptime, then when they are down we must
 * either block every payment or allow every payment. Both answers are wrong,
 * so the dependency must not exist there at all.
 *
 * Behind an interface (ADR-0009/31) so tests use a static implementation and
 * need no network.
 */
import { z } from 'zod';

/**
 * The narrowest logging interface this module needs.
 *
 * Depending on our full pino Logger would mean a caller holding Fastify's
 * FastifyBaseLogger (which lacks msgPrefix) could not use this function at
 * all - and a route handler is exactly the caller we want. Ask for the
 * smallest surface that does the job, and every logger that can warn fits.
 */
export interface WarnLogger {
  warn(details: object, message: string): void;
}

export interface BankDetails {
  readonly ifsc: string;
  readonly bank: string;
  readonly bankCode: string;
  readonly branch: string;
  readonly city: string;
  readonly state: string;
  /** Whether this branch supports UPI - a real field in Razorpay's response. */
  readonly supportsUpi: boolean;
}

export interface BankLookupProvider {
  readonly name: string;
  /** Resolves to null when the IFSC is unknown; throws on transport failure. */
  lookup(ifsc: string): Promise<BankDetails | null>;
}

/** Validated before the call, so only a known-good shape reaches the URL. */
const IFSC_PATTERN = /^[A-Z]{4}0[A-Z0-9]{6}$/;

export class InvalidIfscError extends Error {
  override readonly name = 'InvalidIfscError';
}

/**
 * The external response is UNTRUSTED INPUT, exactly like a request body, so it
 * is parsed rather than assumed. A third party changing a field name should
 * produce a clear failure here, not `undefined` propagating into our database.
 */
const razorpayIfscResponseSchema = z.object({
  IFSC: z.string(),
  BANK: z.string(),
  BANKCODE: z.string(),
  BRANCH: z.string(),
  CITY: z.string(),
  STATE: z.string(),
  UPI: z.boolean(),
});

/**
 * Razorpay's public IFSC API. Keyless, operated by Razorpay, and it returns a
 * per-branch UPI eligibility flag.
 */
export class RazorpayIfscProvider implements BankLookupProvider {
  readonly name = 'razorpay_ifsc';

  /** Fixed host. The caller never supplies a URL, only a validated IFSC. */
  private static readonly BASE_URL = 'https://ifsc.razorpay.com';

  /**
   * 3s, not 2s. The FIRST call pays DNS resolution plus a TLS handshake on top
   * of the request itself, and a live smoke test tripped a 2s budget on a cold
   * connection - degrading correctly, but unnecessarily. Still short enough
   * that a human creating a mandate does not notice.
   */
  constructor(private readonly timeoutMs: number = 3_000) {}

  async lookup(ifsc: string): Promise<BankDetails | null> {
    if (!IFSC_PATTERN.test(ifsc)) {
      // Checked BEFORE the request: the code becomes part of a URL path, so
      // validating it first removes any question of path traversal or
      // request-splitting, and avoids a pointless round trip.
      throw new InvalidIfscError('IFSC must match ^[A-Z]{4}0[A-Z0-9]{6}$');
    }

    // A timeout, and NO RETRIES on this path. Retrying would multiply the
    // delay a user waits during mandate creation, and the operation is
    // optional - degrading immediately is better than being slow.
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const response = await fetch(`${RazorpayIfscProvider.BASE_URL}/${encodeURIComponent(ifsc)}`, {
        signal: controller.signal,
        headers: { accept: 'application/json' },
      });

      // An unknown IFSC is a legitimate answer, not a failure.
      if (response.status === 404) return null;

      if (!response.ok) {
        throw new Error(`IFSC lookup failed with HTTP ${response.status}`);
      }

      const parsed = razorpayIfscResponseSchema.parse(await response.json());

      return {
        ifsc: parsed.IFSC,
        bank: parsed.BANK,
        bankCode: parsed.BANKCODE,
        branch: parsed.BRANCH,
        city: parsed.CITY,
        state: parsed.STATE,
        supportsUpi: parsed.UPI,
      };
    } finally {
      clearTimeout(timer);
    }
  }
}

/** Deterministic, offline provider for tests and for seeding. */
export class StaticBankProvider implements BankLookupProvider {
  readonly name = 'static';

  constructor(private readonly entries: ReadonlyMap<string, BankDetails> = new Map()) {}

  async lookup(ifsc: string): Promise<BankDetails | null> {
    if (!IFSC_PATTERN.test(ifsc)) {
      throw new InvalidIfscError('IFSC must match ^[A-Z]{4}0[A-Z0-9]{6}$');
    }

    return this.entries.get(ifsc) ?? null;
  }
}

/** A provider that always fails, for exercising the degraded path. */
export class FailingBankProvider implements BankLookupProvider {
  readonly name = 'failing';

  constructor(private readonly error: Error = new Error('bank lookup unavailable')) {}

  async lookup(): Promise<BankDetails | null> {
    throw this.error;
  }
}

export interface BankLookupOutcome {
  readonly details: BankDetails | null;
  /** True when the lookup could not be completed. Recorded in the audit event. */
  readonly degraded: boolean;
}

/**
 * Look up a bank WITHOUT ever throwing.
 *
 * This is where graceful degradation lives, deliberately outside the provider:
 * the provider's job is to succeed or fail honestly, and the CALLER decides
 * that failure is survivable. Putting the swallow inside the provider would
 * make it impossible to write a caller that does care.
 *
 * A compliance system must not be unable to create a mandate because a third
 * party is slow. The mandate is created; the bank fields stay null; the
 * degradation is recorded rather than hidden.
 */
export async function lookupBankSafely(
  provider: BankLookupProvider,
  ifsc: string,
  logger: WarnLogger,
): Promise<BankLookupOutcome> {
  try {
    return { details: await provider.lookup(ifsc), degraded: false };
  } catch (error) {
    // An invalid IFSC is the CALLER's error, not a dependency failure - it must
    // surface as a 400 rather than being silently degraded away.
    if (error instanceof InvalidIfscError) throw error;

    logger.warn(
      { err: error, provider: provider.name },
      'bank lookup failed; continuing without bank details',
    );

    return { details: null, degraded: true };
  }
}
