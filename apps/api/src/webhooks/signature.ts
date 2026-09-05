/**
 * Webhook signature verification.
 *
 * WHAT A WEBHOOK ACTUALLY IS: an unauthenticated HTTP request from the open
 * internet, claiming to be your payment provider. Anyone who knows the URL can
 * send one. The signature is the ONLY thing distinguishing a real settlement
 * notification from an attacker announcing that a payment succeeded.
 *
 * Razorpay signs with HMAC-SHA256 over the RAW REQUEST BODY, using the webhook
 * secret configured in their dashboard, and sends it as `x-razorpay-signature`.
 *
 * RAW BYTES, NOT THE PARSED OBJECT. Re-serialising parsed JSON produces
 * different bytes - key order, whitespace, number formatting - and every
 * signature would fail. It is also the safer order, the same as Phase 5:
 * authenticate first, interpret second, so hostile input never reaches the
 * parser on an unverified request.
 */
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';

export const RAZORPAY_SIGNATURE_HEADER = 'x-razorpay-signature';
export const RAZORPAY_EVENT_ID_HEADER = 'x-razorpay-event-id';

/**
 * Verify an HMAC-SHA256 hex signature over raw bytes.
 *
 * Constant time, and returns a boolean rather than throwing. A security check
 * whose outcome depends on the caller's catch block is not a security check.
 */
export function verifyWebhookSignature(
  secret: string,
  rawBody: string,
  signature: string,
): boolean {
  try {
    const expected = createHmac('sha256', secret).update(rawBody, 'utf8').digest();
    const provided = Buffer.from(signature, 'hex');

    // timingSafeEqual throws on a length mismatch, and a wrong length is
    // already a definitive failure.
    if (provided.length !== expected.length) return false;

    return timingSafeEqual(provided, expected);
  } catch {
    return false;
  }
}

/** For the mock provider's own webhooks, and for tests. */
export function signWebhook(secret: string, rawBody: string): string {
  return createHmac('sha256', secret).update(rawBody, 'utf8').digest('hex');
}

/**
 * A stable identifier for this delivery, for idempotency.
 *
 * PREFER THE PROVIDER'S HEADER. A hash of the body is a weaker fallback,
 * because two genuinely distinct events with identical bodies are
 * indistinguishable from one redelivery - so we record WHICH we used, and the
 * `event_id_source` column carries that into the evidence.
 */
export function deliveryId(
  headerValue: unknown,
  rawBody: string,
): { id: string; source: 'header' | 'body_hash' } {
  if (typeof headerValue === 'string' && /^[\x21-\x7e]{1,255}$/.test(headerValue)) {
    return { id: headerValue, source: 'header' };
  }

  return {
    id: createHash('sha256').update(rawBody, 'utf8').digest('hex'),
    source: 'body_hash',
  };
}

export function hashRawBody(rawBody: string): string {
  return createHash('sha256').update(rawBody, 'utf8').digest('hex');
}
