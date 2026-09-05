/**
 * The payment adapters themselves.
 *
 * The mock rail's determinism is a testability property, so it gets tested.
 * The Razorpay provider's LIVE KEY REFUSAL is a safety property, and it is the
 * single most important assertion in this file: moving real money during a
 * demonstration is the worst mistake this project could make.
 */
import { describe, expect, it } from 'vitest';
import {
  MockUpiProvider, PaymentProviderError, RazorpayTestProvider, selectPaymentProvider,
} from './payment.js';

const intent = {
  paymentId: 'pay_abc123', amountPaise: 124_000, merchantId: 'mer_bigbasket',
  mandateId: 'mnd_weekly_groceries', voucherJti: 'a'.repeat(32),
  description: 'test',
};

describe('MockUpiProvider is deterministic and labelled', () => {
  const provider = new MockUpiProvider(0);

  it('always reports itself as simulated', () => {
    expect(provider.simulated).toBe(true);
    expect(provider.name).toBe('mock_upi');
  });

  it('authorizes a normal amount', async () => {
    const result = await provider.authorize(intent);

    expect(result.outcome).toBe('authorized');
    expect(result.simulated).toBe(true);
    expect(result.providerPaymentId).not.toBeNull();
  });

  it('produces the SAME provider references for the same voucher', async () => {
    // A real idempotent provider does this, so the mock does too - otherwise a
    // retry would look like a different payment during reconciliation.
    const a = await provider.authorize(intent);
    const b = await provider.authorize(intent);

    expect(a.providerOrderId).toBe(b.providerOrderId);
    expect(a.providerPaymentId).toBe(b.providerPaymentId);
  });

  it('produces different references for a different voucher', async () => {
    const other = await provider.authorize({ ...intent, voucherJti: 'b'.repeat(32) });
    const original = await provider.authorize(intent);

    expect(other.providerOrderId).not.toBe(original.providerOrderId);
  });

  it('declines any amount ending in 13 paise, every time', async () => {
    // The documented failure rule. It exists so the failure PATH is
    // demonstrable on demand - waiting for a real decline is not a test
    // strategy, and a random failure would make the suite flaky.
    for (const amount of [50_013, 113, 1_000_013]) {
      const result = await provider.authorize({ ...intent, amountPaise: amount });

      expect(result.outcome, `${amount} must decline`).toBe('failed');
      expect(result.failureReason).toContain('SIMULATED');
    }
  });

  it('does not decline amounts that merely contain 13', async () => {
    for (const amount of [131_300, 13_000, 1_300]) {
      const result = await provider.authorize({ ...intent, amountPaise: amount });
      expect(result.outcome, `${amount} must authorize`).toBe('authorized');
    }
  });

  it('captures what it authorized', async () => {
    const authorized = await provider.authorize(intent);
    const captured = await provider.capture(intent, authorized.providerPaymentId!);

    expect(captured.outcome).toBe('captured');
    expect(captured.simulated).toBe(true);
  });
});

describe('RazorpayTestProvider refuses to touch real money', () => {
  it('REFUSES a live key', () => {
    // THE MOST IMPORTANT ASSERTION IN THIS FILE. A live key in this project
    // would mean a demonstration moving real money.
    expect(() => new RazorpayTestProvider('rzp_live_abcdef', 'secret'))
      .toThrow(PaymentProviderError);
    expect(() => new RazorpayTestProvider('rzp_live_abcdef', 'secret'))
      .toThrow(/TEST key/);
  });

  it('refuses anything that is not clearly a test key', () => {
    for (const key of ['', 'abcdef', 'rzp_', 'RZP_TEST_ABC', 'test_rzp_abc']) {
      expect(() => new RazorpayTestProvider(key, 'secret'), key).toThrow(PaymentProviderError);
    }
  });

  it('accepts a test key', () => {
    const provider = new RazorpayTestProvider('rzp_test_abcdef', 'secret');

    expect(provider.name).toBe('razorpay_test');
    // NOT simulated: the payment execution is genuinely real (test mode).
    // The MANDATE rail is what remains a simulation, and that is separate.
    expect(provider.simulated).toBe(false);
  });
});

describe('provider selection defaults to the simulated rail', () => {
  it('uses the mock when no Razorpay keys are configured', () => {
    // So nothing calls an external payment API by accident, from a test suite
    // or a demo.
    expect(selectPaymentProvider({}).name).toBe('mock_upi');
    expect(selectPaymentProvider({ RAZORPAY_KEY_ID: 'rzp_test_x' }).name).toBe('mock_upi');
  });

  it('uses Razorpay only when BOTH keys are present', () => {
    const provider = selectPaymentProvider({
      RAZORPAY_KEY_ID: 'rzp_test_abcdef', RAZORPAY_KEY_SECRET: 'secret',
    });

    expect(provider.name).toBe('razorpay_test');
  });
});
