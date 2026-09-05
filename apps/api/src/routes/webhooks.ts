/**
 * POST /v1/webhooks/razorpay - the provider tells us what happened.
 *
 * THREE PROPERTIES, AND ALL THREE ARE LOAD-BEARING:
 *
 * 1. VERIFIED. A webhook is an unauthenticated request from the internet
 *    claiming to be Razorpay. Without the HMAC check, anyone who knows this URL
 *    can mark any payment captured. The signature is the whole of the
 *    authentication.
 *
 * 2. IDEMPOTENT. Delivery is at-least-once: providers retry on any non-2xx and
 *    on timeouts, including timeouts that happen after we already succeeded.
 *    `UNIQUE (provider, provider_event_id)` refuses the second one at INSERT.
 *
 * 3. FAST AND ALWAYS 2xx WHEN WE HAVE THE EVENT. Once the delivery is durably
 *    recorded we answer 200, even for an event we ignore. Returning 500 for an
 *    event we simply do not handle would make the provider retry it forever.
 *    The one exception is a bad signature: that gets 401, because it is not
 *    from the provider at all.
 */
import type { FastifyPluginAsync } from 'fastify';
import type { Config } from '../config.js';
import type { Pool } from '../db/pool.js';
import { withTransaction } from '../db/transaction.js';
import { appendAuditEvent } from '../audit/writer.js';
import {
  deliveryId,
  hashRawBody,
  RAZORPAY_EVENT_ID_HEADER,
  RAZORPAY_SIGNATURE_HEADER,
  verifyWebhookSignature,
} from '../webhooks/signature.js';
import { findDelivery, insertWebhookEvent, type WebhookOutcome } from '../repositories/webhook.js';
import {
  findPaymentByProviderOrderId,
  findPaymentByProviderId,
  markCaptured,
  markFailed,
  UNIQUE_VIOLATION,
} from '../repositories/payment.js';

export interface WebhookRoutesDeps {
  readonly pool: Pool;
  readonly config: Config;
}

type PgError = Error & { code?: string };

/** Razorpay's envelope, as much of it as we actually read. */
interface RazorpayEvent {
  event?: string;
  payload?: {
    payment?: {
      entity?: {
        id?: string;
        order_id?: string;
        amount?: number;
        status?: string;
        error_code?: string;
        error_description?: string;
      };
    };
  };
}

export function webhookRoutes(deps: WebhookRoutesDeps): FastifyPluginAsync {
  const { pool, config } = deps;

  return async function register(app) {
    app.post('/v1/webhooks/razorpay', async (request, reply) => {
      const rawBody = request.rawBody;

      if (typeof rawBody !== 'string' || rawBody.trim() === '') {
        return reply.code(400).send({ error: 'empty_body', requestId: request.id });
      }

      const secret = config.RAZORPAY_WEBHOOK_SECRET;

      if (secret === undefined) {
        // FAIL CLOSED. Without the secret we cannot tell a real notification
        // from a forged one, so we accept neither. Accepting unverified
        // webhooks "for now" would mean anyone who finds this URL can mark
        // payments captured.
        request.log.error('RAZORPAY_WEBHOOK_SECRET is not configured; refusing all webhooks');
        return reply.code(503).send({
          error: 'webhooks_unavailable',
          message: 'Webhook verification is not configured on this deployment.',
          requestId: request.id,
        });
      }

      const signature = request.headers[RAZORPAY_SIGNATURE_HEADER];
      const delivery = deliveryId(request.headers[RAZORPAY_EVENT_ID_HEADER], rawBody);
      const bodyHash = hashRawBody(rawBody);

      const verified =
        typeof signature === 'string' && verifyWebhookSignature(secret, rawBody, signature);

      /* --- 1. Signature ------------------------------------------------ */
      if (!verified) {
        request.log.warn(
          { deliveryId: delivery.id, hasSignature: typeof signature === 'string' },
          'WEBHOOK SIGNATURE REJECTED',
        );

        // Recorded as evidence. Unlike a failed REQUEST signature (PHASE_05
        // section 12), this row has no foreign keys to satisfy, so a forged
        // attempt genuinely can be stored - and counting forgery attempts is
        // exactly what a security review wants.
        await recordDelivery(pool, request.log, {
          provider: 'razorpay_test',
          providerEventId: delivery.id,
          eventIdSource: delivery.source,
          eventType: 'unverified',
          signatureVerified: false,
          outcome: 'rejected',
          outcomeDetail: 'HMAC over the raw body did not match.',
          paymentId: null,
          payload: { note: 'body not parsed: the request was not authenticated' },
          rawBodySha256: bodyHash,
        });

        return reply.code(401).send({
          error: 'invalid_signature',
          message: 'The webhook signature did not verify.',
          requestId: request.id,
        });
      }

      /* --- 2. Idempotency ---------------------------------------------- */
      const seen = await findDelivery(pool, 'razorpay_test', delivery.id);

      if (seen !== null) {
        request.log.info(
          { deliveryId: delivery.id, firstOutcome: seen.outcome },
          'duplicate webhook delivery ignored',
        );

        // 200, not an error. The provider did nothing wrong - at-least-once
        // delivery is the contract. Telling it we failed would make it retry.
        return reply.code(200).send({
          received: true, duplicate: true, originalOutcome: seen.outcome,
          requestId: request.id,
        });
      }

      /* --- 3. Interpret ------------------------------------------------ */
      // Only now is the body parsed. It has been authenticated first.
      // The content-type parser deliberately never fails, so an authenticated
      // request with a broken body reaches here and gets a 400 from us - after
      // its signature has already been checked.
      let event: RazorpayEvent;
      try {
        event = JSON.parse(rawBody) as RazorpayEvent;
      } catch {
        request.log.warn({ deliveryId: delivery.id }, 'verified webhook had a malformed body');
        return reply.code(400).send({ error: 'malformed_json', requestId: request.id });
      }

      const eventType = typeof event.event === 'string' ? event.event : 'unknown';
      const entity = event.payload?.payment?.entity;

      let outcome: WebhookOutcome = 'ignored';
      let detail: string | null = `No handler for event type "${eventType}".`;
      let paymentId: string | null = null;

      if (eventType === 'payment.captured' || eventType === 'payment.failed') {
        // Match on the ORDER id first: at authorize time Razorpay has given us
        // an order but no payment id, because the customer-side half has not
        // happened yet. The payment id only exists once someone pays.
        const payment =
          (entity?.order_id !== undefined
            ? await findPaymentByProviderOrderId(pool, 'razorpay_test', entity.order_id)
            : null) ??
          (entity?.id !== undefined
            ? await findPaymentByProviderId(pool, 'razorpay_test', entity.id)
            : null);

        if (payment === null) {
          outcome = 'unmatched';
          detail = `No local payment matches order ${entity?.order_id ?? '(none)'}.`;
        } else if (eventType === 'payment.captured') {
          paymentId = payment.id;

          // AMOUNT CROSS-CHECK. The provider telling us a DIFFERENT amount was
          // captured is a reconciliation incident, not a routine capture, and
          // must not be silently accepted as if it matched.
          if (typeof entity?.amount === 'number' && entity.amount !== payment.amountPaise) {
            outcome = 'failed';
            detail =
              `Amount mismatch: provider says ${entity.amount} paise, we authorised ` +
              `${payment.amountPaise}. Not captured; requires human reconciliation.`;
            request.log.error(
              { paymentId: payment.id, providerAmount: entity.amount, ourAmount: payment.amountPaise },
              'WEBHOOK AMOUNT MISMATCH',
            );
          } else if (payment.status === 'captured') {
            outcome = 'duplicate';
            detail = 'Payment was already captured.';
          } else {
            await markCaptured(pool, payment.id, entity?.id ?? null);
            outcome = 'captured';
            detail = null;
          }
        } else {
          paymentId = payment.id;

          if (payment.status === 'failed' || payment.status === 'captured') {
            outcome = 'duplicate';
            detail = `Payment is already ${payment.status}.`;
          } else {
            await markFailed(
              pool, payment.id,
              entity?.error_code ?? 'PROVIDER_FAILED',
              entity?.error_description ?? 'The provider reported the payment as failed.',
            );
            outcome = 'failed';
            detail = entity?.error_description ?? null;
          }
        }
      }

      /* --- 4. Record --------------------------------------------------- */
      const recorded = await recordDelivery(pool, request.log, {
        provider: 'razorpay_test',
        providerEventId: delivery.id,
        eventIdSource: delivery.source,
        eventType,
        signatureVerified: true,
        outcome,
        outcomeDetail: detail,
        paymentId,
        payload: event,
        rawBodySha256: bodyHash,
      });

      if (recorded === 'duplicate') {
        // Two deliveries of the same event raced past the read above and both
        // reached the INSERT. The unique constraint caught the second - which
        // is exactly its job.
        return reply.code(200).send({ received: true, duplicate: true, requestId: request.id });
      }

      if (paymentId !== null && (outcome === 'captured' || outcome === 'failed')) {
        await withTransaction(pool, async (tx) => {
          await appendAuditEvent(tx, {
            eventType: outcome === 'captured' ? 'PAYMENT_CAPTURED' : 'PAYMENT_FAILED',
            actorKind: 'system',
            actorId: null,
            subjectKind: 'payment',
            subjectId: paymentId!,
            requestId: String(request.id),
            payload: {
              paymentId, source: 'webhook', provider: 'razorpay_test',
              providerEventId: delivery.id, eventType,
              providerPaymentId: entity?.id ?? null,
              detail,
            },
          });
        });
      }

      return reply.code(200).send({ received: true, outcome, requestId: request.id });
    });
  };
}

async function recordDelivery(
  pool: Pool,
  log: { error: (obj: unknown, msg: string) => void },
  params: Parameters<typeof insertWebhookEvent>[1],
): Promise<'inserted' | 'duplicate'> {
  try {
    await withTransaction(pool, async (tx) => {
      await insertWebhookEvent(tx, params);
    });
    return 'inserted';
  } catch (error) {
    if ((error as PgError).code === UNIQUE_VIOLATION) return 'duplicate';

    log.error({ err: error }, 'failed to record a webhook delivery');
    throw error;
  }
}
