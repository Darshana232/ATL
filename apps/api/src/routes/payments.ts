/**
 * POST /v1/payments - redeem a voucher and move money.
 *
 * THIS IS WHERE ADR-0008 STOPS BEING A DIAGRAM.
 *
 * There is no path through this handler that reaches a payment provider without
 * a valid, unexpired, unspent voucher minted by the deterministic policy engine.
 * A fully prompt-injected agent can call this endpoint all day; without a token
 * it cannot get past the first fifteen lines.
 *
 * THE ORDER OF CHECKS IS THE SECURITY MODEL:
 *
 *   1. authenticate the agent            (Ed25519, Phase 5)
 *   2. verify the voucher MAC            (before reading a single claim)
 *   3. check expiry
 *   4. match the claims to THIS request  (amount, merchant, mandate, agent)
 *   5. cross-check against the stored decision
 *   6. CLAIM THE VOUCHER by INSERT       (UNIQUE - this is the single-use gate)
 *   7. only now: talk to the provider
 */
import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import type { Config } from '../config.js';
import type { Pool } from '../db/pool.js';
import { withTransaction } from '../db/transaction.js';
import { appendAuditEvent } from '../audit/writer.js';
import { requireAgentSignature } from '../middleware/agent-auth.js';
import { verifyVoucher } from '../voucher/voucher.js';
import type { PaymentProvider } from '../providers/payment.js';
import {
  findPaymentById,
  findPaymentByVoucherJti,
  insertPayment,
  loadDecisionForPayment,
  markAuthorized,
  markCaptured,
  markFailed,
  newPaymentId,
  UNIQUE_VIOLATION,
} from '../repositories/payment.js';

export interface PaymentRoutesDeps {
  readonly pool: Pool;
  readonly config: Config;
  readonly provider: PaymentProvider;
  readonly now?: () => Date;
}

type PgError = Error & { code?: string; constraint?: string };

const payBodySchema = z.strictObject({
  voucher: z.string().min(20).max(4096),
  /**
   * Echoed by the caller and CROSS-CHECKED against the voucher claims.
   *
   * Not redundant. The voucher says what was approved; these say what is being
   * attempted. Requiring them to match is what makes the token a CAPABILITY for
   * one specific payment rather than a bearer credential for any payment.
   */
  amountPaise: z.int().positive(),
  merchantId: z.string().regex(/^mer_[a-z0-9_]{2,40}$/),
});

const SIMULATION_NOTICE =
  'The mandate authorization rail is an MVP SIMULATION, not an NPCI or ' +
  'Razorpay production integration.';

export function paymentRoutes(deps: PaymentRoutesDeps): FastifyPluginAsync {
  const { pool, config, provider } = deps;
  const clock = deps.now ?? (() => new Date());

  return async function register(app) {
    app.post(
      '/v1/payments',
      { preHandler: requireAgentSignature({ pool, now: clock }) },
      async (request, reply) => {
        const agent = request.atlAgent;
        if (agent === undefined) {
          request.log.error('payments reached the handler without an authenticated agent');
          return reply.code(500).send({
            error: 'internal_error', message: 'An unexpected error occurred.',
            requestId: request.id,
          });
        }

        const parsed = payBodySchema.safeParse(request.body);
        if (!parsed.success) {
          return reply.code(400).send({
            error: 'validation_failed',
            message: 'The request body is not valid.',
            issues: parsed.error.issues.map((i) => ({
              field: i.path.join('.') || '(body)', message: i.message,
            })),
            requestId: request.id,
          });
        }

        const body = parsed.data;
        const now = clock();

        const secret = config.VOUCHER_SIGNING_SECRET;
        if (secret === undefined) {
          // FAIL CLOSED. Without the secret we cannot distinguish a real
          // voucher from a forged one, so we accept neither.
          request.log.error('VOUCHER_SIGNING_SECRET is not configured; refusing all payments');
          return reply.code(503).send({
            error: 'payments_unavailable',
            message: 'Payment authorization is not configured on this deployment.',
            requestId: request.id,
          });
        }

        /* --- 2 & 3. The voucher itself --------------------------------- */
        const voucher = verifyVoucher(secret, body.voucher, now);

        if (!voucher.ok) {
          request.log.warn(
            { agentId: agent.agentId, why: voucher.why },
            'payment refused: voucher did not verify',
          );

          // One message for every cause, as with authentication. "Expired" and
          // "forged" are different lines in OUR log and the same answer to the
          // caller, so probing cannot map our state.
          return reply.code(401).send({
            error: 'invalid_voucher',
            message:
              'A valid, unexpired payment voucher is required. Vouchers are ' +
              'issued only by POST /v1/authorize and only on PASS or FLAG.',
            requestId: request.id,
          });
        }

        const claims = voucher.claims;

        /* --- 4. Do the claims describe THIS payment? -------------------- */
        const mismatches: string[] = [];
        if (claims.amountPaise !== body.amountPaise) mismatches.push('amountPaise');
        if (claims.merchantId !== body.merchantId) mismatches.push('merchantId');
        // The voucher is bound to the agent it was issued to. A stolen voucher
        // is useless to a different agent, because that agent cannot produce a
        // matching Ed25519 signature AND present a voucher naming itself.
        if (claims.agentId !== agent.agentId) mismatches.push('agentId');

        if (mismatches.length > 0) {
          request.log.warn(
            { agentId: agent.agentId, mismatches, jti: claims.jti },
            'payment refused: voucher does not match the attempted payment',
          );

          return reply.code(409).send({
            error: 'voucher_mismatch',
            message:
              'This voucher authorises a different payment. A voucher permits ' +
              'exactly one amount at exactly one merchant for exactly one agent.',
            mismatchedFields: mismatches,
            requestId: request.id,
          });
        }

        /* --- 5. Cross-check against the stored decision ----------------- */
        // Belt and braces: the claims are already MAC-protected, but a decision
        // that does not exist, or that was a BLOCK, means something is very
        // wrong and must not quietly proceed.
        const decision = await loadDecisionForPayment(pool, claims.decisionId);

        if (decision === null) {
          request.log.error({ jti: claims.jti, decisionId: claims.decisionId },
            'a MAC-valid voucher named a decision that does not exist');
          return reply.code(409).send({
            error: 'voucher_mismatch',
            message: 'This voucher refers to a decision that no longer exists.',
            requestId: request.id,
          });
        }

        if (decision.verdict === 'BLOCK') {
          // Unreachable through our own code - BLOCK mints no voucher. Reaching
          // it would mean the minting logic had regressed, so it is logged as
          // an error rather than a warning.
          request.log.error({ decisionId: decision.decisionId },
            'a voucher existed for a BLOCKED decision');
          return reply.code(409).send({
            error: 'decision_blocked',
            message: 'The authorization for this payment was blocked.',
            requestId: request.id,
          });
        }

        if (
          decision.amountPaise !== body.amountPaise ||
          decision.merchantId !== body.merchantId ||
          decision.mandateId !== claims.mandateId
        ) {
          return reply.code(409).send({
            error: 'voucher_mismatch',
            message: 'This voucher does not match the decision it refers to.',
            requestId: request.id,
          });
        }

        /* --- 6. CLAIM THE VOUCHER -------------------------------------- */
        const paymentId = newPaymentId();

        try {
          await withTransaction(pool, async (tx) => {
            await insertPayment(tx, {
              id: paymentId,
              decisionId: decision.decisionId,
              mandateId: decision.mandateId,
              voucherJti: claims.jti,
              amountPaise: body.amountPaise,
              provider: provider.name,
            });

            await appendAuditEvent(tx, {
              eventType: 'PAYMENT_INITIATED',
              actorKind: 'agent',
              actorId: agent.agentId,
              subjectKind: 'payment',
              subjectId: paymentId,
              requestId: String(request.id),
              mandateId: decision.mandateId,
              payload: {
                paymentId,
                decisionId: decision.decisionId,
                voucherJti: claims.jti,
                amountPaise: body.amountPaise,
                merchantId: body.merchantId,
                provider: provider.name,
                simulated: provider.simulated,
              },
            });
          });
        } catch (error) {
          const pgError = error as PgError;

          // THE SINGLE-USE GATE, and it is a database constraint rather than a
          // lookup. An application-level "have we seen this jti?" would lose
          // this exact race.
          if (pgError.code === UNIQUE_VIOLATION) {
            const existing = await findPaymentByVoucherJti(pool, claims.jti);

            request.log.warn(
              { jti: claims.jti, existingPaymentId: existing?.id },
              'voucher replay refused by the unique constraint',
            );

            return reply.code(409).send({
              error: 'voucher_already_used',
              message:
                'This voucher has already been redeemed. A voucher permits ' +
                'exactly one payment, enforced by a database constraint.',
              payment: existing === null ? null : {
                id: existing.id, status: existing.status, amountPaise: existing.amountPaise,
              },
              requestId: request.id,
            });
          }

          throw error;
        }

        /* --- 7. Only now: the provider --------------------------------- */
        const intent = {
          paymentId,
          amountPaise: body.amountPaise,
          merchantId: body.merchantId,
          mandateId: decision.mandateId,
          voucherJti: claims.jti,
          description: `ATL-India authorized payment ${paymentId}`,
        };

        const authorized = await provider.authorize(intent);

        if (authorized.outcome === 'failed') {
          await markFailed(
            pool, paymentId,
            authorized.failureCode ?? 'PROVIDER_FAILED',
            authorized.failureReason ?? 'The payment provider declined the payment.',
          );
          await recordPaymentEvent(pool, {
            eventType: 'PAYMENT_FAILED', agentId: agent.agentId, paymentId,
            mandateId: decision.mandateId, requestId: String(request.id),
            payload: {
              paymentId, stage: 'authorize',
              failureCode: authorized.failureCode, failureReason: authorized.failureReason,
              provider: provider.name, simulated: provider.simulated,
            },
          });

          return reply.code(200).send({
            paymentId, status: 'failed',
            failureCode: authorized.failureCode,
            failureReason: authorized.failureReason,
            provider: provider.name,
            simulated: provider.simulated,
            simulation: SIMULATION_NOTICE,
            requestId: request.id,
          });
        }

        await markAuthorized(
          pool, paymentId, authorized.providerOrderId, authorized.providerPaymentId,
        );

        /* --- Capture ---------------------------------------------------- */
        // A provider that has not issued a payment id yet (Razorpay: the
        // customer-side half has not happened) leaves the payment AUTHORIZED and
        // waits for the webhook. Capturing here would be recording money as
        // moved on the strength of nothing.
        if (authorized.providerPaymentId === null) {
          await recordPaymentEvent(pool, {
            eventType: 'PAYMENT_AUTHORIZED', agentId: agent.agentId, paymentId,
            mandateId: decision.mandateId, requestId: String(request.id),
            payload: {
              paymentId, providerOrderId: authorized.providerOrderId,
              provider: provider.name, simulated: provider.simulated,
              awaiting: 'customer payment against the order, confirmed by webhook',
            },
          });

          return reply.code(202).send({
            paymentId, status: 'authorized',
            providerOrderId: authorized.providerOrderId,
            provider: provider.name,
            simulated: provider.simulated,
            message: 'Authorized. Capture will complete when the provider confirms payment.',
            simulation: SIMULATION_NOTICE,
            requestId: request.id,
          });
        }

        const captured = await provider.capture(intent, authorized.providerPaymentId);

        if (captured.outcome !== 'captured') {
          await markFailed(
            pool, paymentId,
            captured.failureCode ?? 'CAPTURE_FAILED',
            captured.failureReason ?? 'The payment provider declined the capture.',
          );
          await recordPaymentEvent(pool, {
            eventType: 'PAYMENT_FAILED', agentId: agent.agentId, paymentId,
            mandateId: decision.mandateId, requestId: String(request.id),
            payload: {
              paymentId, stage: 'capture',
              failureCode: captured.failureCode, failureReason: captured.failureReason,
              provider: provider.name, simulated: provider.simulated,
            },
          });

          return reply.code(200).send({
            paymentId, status: 'failed',
            failureCode: captured.failureCode, failureReason: captured.failureReason,
            provider: provider.name, simulated: provider.simulated,
            simulation: SIMULATION_NOTICE, requestId: request.id,
          });
        }

        await markCaptured(pool, paymentId, captured.providerPaymentId);
        await recordPaymentEvent(pool, {
          eventType: 'PAYMENT_CAPTURED', agentId: agent.agentId, paymentId,
          mandateId: decision.mandateId, requestId: String(request.id),
          payload: {
            paymentId, decisionId: decision.decisionId, voucherJti: claims.jti,
            amountPaise: body.amountPaise, merchantId: body.merchantId,
            providerPaymentId: captured.providerPaymentId,
            provider: provider.name, simulated: provider.simulated,
          },
        });

        request.log.info(
          { paymentId, amountPaise: body.amountPaise, provider: provider.name },
          'payment captured',
        );

        return reply.code(201).send({
          paymentId,
          status: 'captured',
          amountPaise: body.amountPaise,
          merchantId: body.merchantId,
          decisionId: decision.decisionId,
          voucherJti: claims.jti,
          provider: provider.name,
          providerPaymentId: captured.providerPaymentId,
          // Never omitted. A report must be unable to present a simulated
          // settlement as a real one.
          simulated: provider.simulated,
          simulation: SIMULATION_NOTICE,
          requestId: request.id,
        });
      },
    );

    /* ------------------------------------------------------------------ */
    app.get<{ Params: { id: string } }>(
      '/v1/payments/:id',
      { preHandler: requireAgentSignature({ pool, now: clock }) },
      async (request, reply) => {
        const payment = await findPaymentById(pool, request.params.id);

        if (payment === null) {
          return reply.code(404).send({
            error: 'payment_not_found',
            message: `Payment ${request.params.id} does not exist.`,
            requestId: request.id,
          });
        }

        return reply.code(200).send({
          ...payment,
          createdAt: payment.createdAt.toISOString(),
          capturedAt: payment.capturedAt?.toISOString() ?? null,
          simulated: payment.provider === 'mock_upi',
          simulation: SIMULATION_NOTICE,
        });
      },
    );
  };
}

/**
 * Audit a payment lifecycle event.
 *
 * Deliberately NOT inside the payment's own transaction. The provider call has
 * already happened by the time we get here, so there is nothing left to roll
 * back - and a failure to write the audit row must not make us forget a payment
 * that really occurred. It is logged loudly instead, which is the correct
 * trade when the alternative is losing the money record.
 */
async function recordPaymentEvent(
  pool: Pool,
  params: {
    eventType: string; agentId: string; paymentId: string;
    mandateId: string; requestId: string;
    payload: Record<string, unknown>;
  },
): Promise<void> {
  await withTransaction(pool, async (tx) => {
    await appendAuditEvent(tx, {
      eventType: params.eventType,
      actorKind: 'agent',
      actorId: params.agentId,
      subjectKind: 'payment',
      subjectId: params.paymentId,
      requestId: params.requestId,
      mandateId: params.mandateId,
      payload: params.payload as never,
    });
  });
}
