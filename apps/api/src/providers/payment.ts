/**
 * Payment providers, behind one interface.
 *
 * ============================ HONEST LABELLING ============================
 * `MockUpiProvider`      SIMULATED. No money moves. Every row it writes carries
 *                        provider = 'mock_upi', so a report physically cannot
 *                        present its settlements as real ones.
 *
 * `RazorpayTestProvider` REAL INTEGRATION with Razorpay's test-mode API. Real
 *                        API, real orders, real test payments - no real money,
 *                        and no full KYC required. What is NOT real is the
 *                        agentic MANDATE RAIL: Razorpay's agentic-payments
 *                        product is a live pilot with no public developer API
 *                        (RESEARCH_REALITY_CHECK item 1), so mandate
 *                        authorization is ours and is simulated regardless of
 *                        which provider executes the payment.
 * ==========================================================================
 *
 * The interface exists so nothing blocks on credentials (ADR-0009), and so the
 * day test keys arrive the real provider drops in behind an unchanged contract.
 */
import { createHash } from 'node:crypto';

export type PaymentOutcome = 'authorized' | 'captured' | 'failed';

export interface PaymentIntent {
  /** Our payment id. Sent to the provider as a reference, so we can reconcile. */
  readonly paymentId: string;
  readonly amountPaise: number;
  readonly merchantId: string;
  readonly mandateId: string;
  /** The voucher id. Sent as the provider's idempotency key where supported. */
  readonly voucherJti: string;
  readonly description: string;
}

export interface PaymentResult {
  readonly outcome: PaymentOutcome;
  readonly providerOrderId: string | null;
  readonly providerPaymentId: string | null;
  readonly failureCode: string | null;
  readonly failureReason: string | null;
  /** Whether real money could have moved. Recorded, and shown in the UI. */
  readonly simulated: boolean;
  readonly latencyMs: number;
}

export interface PaymentProvider {
  /** Matches `payments_provider_valid` in migration 0004. */
  readonly name: 'mock_upi' | 'razorpay_test';
  readonly simulated: boolean;
  authorize(intent: PaymentIntent): Promise<PaymentResult>;
  capture(intent: PaymentIntent, providerPaymentId: string): Promise<PaymentResult>;
}

/* ------------------------------------------------------------------------ */
/* Mock UPI - SIMULATED                                                     */
/* ------------------------------------------------------------------------ */

/**
 * A deterministic simulated UPI rail.
 *
 * DETERMINISTIC ON PURPOSE, even though real rails are not:
 *
 *   - a demo must be reproducible
 *   - a test that asserts on a random outcome fails on Tuesdays
 *   - the FAILURE PATH must be demonstrable on demand, and waiting for a real
 *     decline is not a test strategy
 *
 * THE FAILURE RULE: any amount whose last two digits (the paise part) are `13`
 * fails. It is arbitrary, documented, and easy to trigger in a demo - ₹500.13
 * declines every time. Nothing else fails.
 */
export class MockUpiProvider implements PaymentProvider {
  readonly name = 'mock_upi' as const;
  readonly simulated = true;

  /** Injected so tests do not wait for simulated latency. */
  constructor(private readonly delayMs = 0) {}

  private reference(intent: PaymentIntent, kind: string): string {
    // Derived from the voucher, so retrying the same authorization produces the
    // same provider reference - which is what a real idempotent provider does.
    return `${kind}_${createHash('sha256')
      .update(`mock:${kind}:${intent.voucherJti}`)
      .digest('hex')
      .slice(0, 14)}`;
  }

  private shouldFail(amountPaise: number): boolean {
    return amountPaise % 100 === 13;
  }

  private async pause(): Promise<void> {
    if (this.delayMs > 0) await new Promise((resolve) => setTimeout(resolve, this.delayMs));
  }

  async authorize(intent: PaymentIntent): Promise<PaymentResult> {
    const startedAt = Date.now();
    await this.pause();

    if (this.shouldFail(intent.amountPaise)) {
      return {
        outcome: 'failed',
        providerOrderId: this.reference(intent, 'order'),
        providerPaymentId: null,
        failureCode: 'SIMULATED_DECLINE',
        failureReason:
          'SIMULATED: the mock UPI rail declines any amount ending in 13 paise, ' +
          'so the failure path is demonstrable on demand.',
        simulated: true,
        latencyMs: Date.now() - startedAt,
      };
    }

    return {
      outcome: 'authorized',
      providerOrderId: this.reference(intent, 'order'),
      providerPaymentId: this.reference(intent, 'pay'),
      failureCode: null,
      failureReason: null,
      simulated: true,
      latencyMs: Date.now() - startedAt,
    };
  }

  async capture(intent: PaymentIntent, providerPaymentId: string): Promise<PaymentResult> {
    const startedAt = Date.now();
    await this.pause();

    return {
      outcome: 'captured',
      providerOrderId: this.reference(intent, 'order'),
      providerPaymentId,
      failureCode: null,
      failureReason: null,
      simulated: true,
      latencyMs: Date.now() - startedAt,
    };
  }
}

/* ------------------------------------------------------------------------ */
/* Razorpay test mode - REAL API                                            */
/* ------------------------------------------------------------------------ */

export class PaymentProviderError extends Error {
  override readonly name = 'PaymentProviderError';
  constructor(message: string, readonly code: string) {
    super(message);
  }
}

/**
 * Razorpay test mode.
 *
 * Creates a real Order through `api.razorpay.com/v1/orders` with test keys. An
 * order is the merchant-side half of a payment: the customer-side half needs
 * Checkout in a browser, which an autonomous agent has no way to complete. So
 * this provider genuinely creates and reads real test-mode objects, and the
 * capture step is completed by the WEBHOOK when a payment is made against the
 * order - which is exactly how it works in production.
 *
 * TIMEOUT AND FAIL-CLOSED. If Razorpay does not answer inside the budget we
 * return `failed` and never `captured`. On a payment path, "we do not know"
 * must never be recorded as "money moved" - a payment wrongly marked captured
 * is a reconciliation problem that costs a human hours; a payment wrongly
 * marked failed is a retry.
 */
export class RazorpayTestProvider implements PaymentProvider {
  readonly name = 'razorpay_test' as const;
  readonly simulated = false;

  private readonly base = 'https://api.razorpay.com/v1';

  constructor(
    private readonly keyId: string,
    private readonly keySecret: string,
    private readonly timeoutMs = 8_000,
  ) {
    // Refusing a live key is a guard against the worst possible mistake in this
    // project: moving real money during a demonstration.
    if (!keyId.startsWith('rzp_test_')) {
      throw new PaymentProviderError(
        'RAZORPAY_KEY_ID must be a TEST key (rzp_test_...). Live keys are refused.',
        'LIVE_KEY_REFUSED',
      );
    }
  }

  private authHeader(): string {
    return `Basic ${Buffer.from(`${this.keyId}:${this.keySecret}`).toString('base64')}`;
  }

  async authorize(intent: PaymentIntent): Promise<PaymentResult> {
    const startedAt = Date.now();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const response = await fetch(`${this.base}/orders`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: this.authHeader(),
        },
        body: JSON.stringify({
          // Razorpay's own API takes `amount` in paise - the same unit we store.
          // No conversion, so no rounding, so no lost paise.
          amount: intent.amountPaise,
          currency: 'INR',
          receipt: intent.paymentId,
          notes: {
            atl_mandate_id: intent.mandateId,
            atl_voucher_jti: intent.voucherJti,
            atl_note: 'Authorization by ATL-India (simulated mandate rail)',
          },
        }),
        signal: controller.signal,
      });

      const body = (await response.json()) as { id?: string; error?: { code?: string; description?: string } };

      if (!response.ok) {
        return {
          outcome: 'failed',
          providerOrderId: null,
          providerPaymentId: null,
          failureCode: body.error?.code ?? `HTTP_${response.status}`,
          failureReason: body.error?.description ?? 'Razorpay rejected the order.',
          simulated: false,
          latencyMs: Date.now() - startedAt,
        };
      }

      return {
        outcome: 'authorized',
        providerOrderId: body.id ?? null,
        // Deliberately null: a Razorpay payment id only exists once a CUSTOMER
        // pays against the order. Inventing one here would put a fiction in the
        // reconciliation record.
        providerPaymentId: null,
        failureCode: null,
        failureReason: null,
        simulated: false,
        latencyMs: Date.now() - startedAt,
      };
    } catch (error) {
      // Includes the timeout. FAIL CLOSED - see the class comment.
      return {
        outcome: 'failed',
        providerOrderId: null,
        providerPaymentId: null,
        failureCode: 'PROVIDER_UNREACHABLE',
        failureReason:
          `Razorpay did not respond within ${this.timeoutMs}ms. Recorded as failed, ` +
          `never as captured: on a payment path "we do not know" must not become ` +
          `"money moved".`,
        simulated: false,
        latencyMs: Date.now() - startedAt,
      };
    } finally {
      clearTimeout(timer);
    }
  }

  async capture(intent: PaymentIntent, providerPaymentId: string): Promise<PaymentResult> {
    const startedAt = Date.now();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const response = await fetch(`${this.base}/payments/${providerPaymentId}/capture`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: this.authHeader() },
        body: JSON.stringify({ amount: intent.amountPaise, currency: 'INR' }),
        signal: controller.signal,
      });

      const body = (await response.json()) as {
        id?: string; order_id?: string; error?: { code?: string; description?: string };
      };

      if (!response.ok) {
        return {
          outcome: 'failed',
          providerOrderId: body.order_id ?? null,
          providerPaymentId,
          failureCode: body.error?.code ?? `HTTP_${response.status}`,
          failureReason: body.error?.description ?? 'Razorpay rejected the capture.',
          simulated: false,
          latencyMs: Date.now() - startedAt,
        };
      }

      return {
        outcome: 'captured',
        providerOrderId: body.order_id ?? null,
        providerPaymentId: body.id ?? providerPaymentId,
        failureCode: null,
        failureReason: null,
        simulated: false,
        latencyMs: Date.now() - startedAt,
      };
    } catch {
      return {
        outcome: 'failed',
        providerOrderId: null,
        providerPaymentId,
        failureCode: 'PROVIDER_UNREACHABLE',
        failureReason: `Razorpay did not respond within ${this.timeoutMs}ms.`,
        simulated: false,
        latencyMs: Date.now() - startedAt,
      };
    } finally {
      clearTimeout(timer);
    }
  }
}

/**
 * Choose a provider from config.
 *
 * The MOCK is the default. Using the real provider requires deliberately
 * supplying test keys, so nobody accidentally starts calling an external API
 * from a test suite or a demo.
 */
export function selectPaymentProvider(config: {
  RAZORPAY_KEY_ID?: string;
  RAZORPAY_KEY_SECRET?: string;
}): PaymentProvider {
  if (config.RAZORPAY_KEY_ID !== undefined && config.RAZORPAY_KEY_SECRET !== undefined) {
    return new RazorpayTestProvider(config.RAZORPAY_KEY_ID, config.RAZORPAY_KEY_SECRET);
  }

  return new MockUpiProvider();
}
