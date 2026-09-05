/**
 * Webhook signature verification.
 *
 * A webhook is an unauthenticated request from the internet claiming to be your
 * payment provider. This function is the entire difference between a real
 * settlement notification and an attacker announcing a payment succeeded.
 */
import { describe, expect, it } from 'vitest';
import { deliveryId, hashRawBody, signWebhook, verifyWebhookSignature } from './signature.js';

const SECRET = 'whsec_example_value';
const BODY = JSON.stringify({ event: 'payment.captured', payload: { amount: 124000 } });

describe('verification', () => {
  const signature = signWebhook(SECRET, BODY);

  it('accepts a genuine signature', () => {
    expect(verifyWebhookSignature(SECRET, BODY, signature)).toBe(true);
  });

  it('rejects a body altered by ONE character', () => {
    // PREVENTS: intercepting a real notification and changing the amount.
    const altered = BODY.replace('124000', '124001');
    expect(verifyWebhookSignature(SECRET, altered, signature)).toBe(false);
  });

  it('rejects a signature made with a different secret', () => {
    expect(verifyWebhookSignature('another-secret', BODY, signature)).toBe(false);
  });

  it('rejects reordered JSON keys, because the signature covers RAW BYTES', () => {
    // Which is exactly why the raw body must be kept: re-serialising the parsed
    // object produces different bytes and every signature would fail.
    const reordered = JSON.stringify({ payload: { amount: 124000 }, event: 'payment.captured' });
    expect(verifyWebhookSignature(SECRET, reordered, signature)).toBe(false);
  });

  it('returns false rather than throwing on malformed input', () => {
    for (const bad of ['', 'zz', 'not-hex', 'ab', 'a'.repeat(63), 'a'.repeat(200)]) {
      expect(verifyWebhookSignature(SECRET, BODY, bad), bad).toBe(false);
    }
  });
});

describe('delivery identity', () => {
  it('prefers the provider header', () => {
    const result = deliveryId('evt_MkS9xyz123', BODY);

    expect(result).toEqual({ id: 'evt_MkS9xyz123', source: 'header' });
  });

  it('falls back to a body hash when there is no header', () => {
    // Weaker, and RECORDED as weaker: two genuinely distinct events with
    // identical bodies are indistinguishable from one redelivery.
    const result = deliveryId(undefined, BODY);

    expect(result.source).toBe('body_hash');
    expect(result.id).toBe(hashRawBody(BODY));
  });

  it('refuses a header with a newline or control characters', () => {
    // The same header-injection reasoning as the request signature in Phase 5.
    for (const bad of ['evt_a\nevt_b', 'evt a', 'a'.repeat(256), '']) {
      expect(deliveryId(bad, BODY).source, JSON.stringify(bad)).toBe('body_hash');
    }
  });

  it('refuses a repeated header rather than resolving it', () => {
    expect(deliveryId(['evt_a', 'evt_b'], BODY).source).toBe('body_hash');
  });
});
