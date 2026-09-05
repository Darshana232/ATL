/**
 * POST /v1/authorize - the only door into the policy engine.
 *
 * This handler is where every piece built so far meets:
 *
 *   auth/signing.ts        proves WHO is asking
 *   repositories/spend.ts  locks the mandate and computes trustworthy state
 *   policy/engine.ts       decides, purely and explainably
 *   audit/writer.ts        records it in a hash chain
 *   voucher/voucher.ts     mints the capability that lets money move
 *
 * THE ORDER IS THE ARCHITECTURE. Authenticate, then lock, then read, then
 * decide, then record, then - only then - mint. Nothing before the engine can
 * produce a voucher, and the engine cannot be reached without a verified
 * signature.
 */
import type { FastifyPluginAsync } from 'fastify';
import type { Config } from '../config.js';
import type { Pool } from '../db/pool.js';
import { withTransaction } from '../db/transaction.js';
import { appendAuditEvent } from '../audit/writer.js';
import { requireAgentSignature } from '../middleware/agent-auth.js';
import { agentRateLimit } from '../middleware/agent-rate-limit.js';
import { evaluate } from '../policy/engine.js';
import { toPaise } from '../money.js';
import { loadForAuthorization } from '../repositories/mandate.js';
import {
  lockMandateForAuthorization,
  readSpendSnapshot,
  windowBoundsFor,
} from '../repositories/spend.js';
import {
  findDecisionByIdempotencyKey,
  insertAuthorizationRequest,
  insertDecision,
  insertRiskSignal,
  loadMerchantMcc,
  newAuthorizationRequestId,
  newDecisionId,
  newRiskSignalId,
  type StoredDecision,
} from '../repositories/authorization.js';
import { mintVoucher, voucherJtiFor, VOUCHER_TTL_MS } from '../voucher/voucher.js';
import { authorizeBodySchema, type AuthorizeResponse } from '../dto/authorization.js';
import type { RiskProvider } from '../providers/risk.js';
import type { CanonicalValue } from '../audit/canonical.js';

export interface AuthorizeRoutesDeps {
  readonly pool: Pool;
  readonly config: Config;
  readonly risk: RiskProvider;
  /** Injectable clock. Tests drive expiry and windows without fake timers. */
  readonly now?: () => Date;
}

/**
 * Honest labelling, on every single response.
 *
 * `Claude/CLAUDE.md` section 33 forbids presenting a simulated rail as a real
 * integration. Putting it in the API contract rather than only in the README
 * means a screenshot, a curl transcript and a dashboard cell all carry it, and
 * nobody has to remember to add the caveat.
 */
const SIMULATION_NOTICE =
  'SIMULATED MANDATE RAIL. Authorization is real and deterministic; the ' +
  'underlying UPI mandate rail is an MVP simulation, not an NPCI or Razorpay ' +
  'production integration.';

const UNIQUE_VIOLATION = '23505';

type PgError = Error & { code?: string; constraint?: string };

function storedToResponse(
  stored: StoredDecision,
  voucher: AuthorizeResponse['voucher'],
): AuthorizeResponse {
  return {
    decisionId: stored.decisionId,
    authorizationRequestId: stored.authorizationRequestId,
    verdict: stored.verdict,
    reason: stored.reason,
    engineVersion: stored.engineVersion,
    mandateId: stored.mandateId,
    mandateVersion: stored.mandateVersion,
    evaluatedAt: stored.evaluatedAt.toISOString(),
    evaluations: stored.evaluations,
    voucher,
    risk:
      stored.riskProvider === null || stored.riskScore === null
        ? null
        : { provider: stored.riskProvider, score: stored.riskScore, band: bandOf(stored.riskScore) },
    simulation: SIMULATION_NOTICE,
    idempotentReplay: true,
  };
}

function bandOf(score: number): string {
  return score >= 70 ? 'HIGH' : score >= 40 ? 'MEDIUM' : 'LOW';
}

export function authorizeRoutes(deps: AuthorizeRoutesDeps): FastifyPluginAsync {
  const { pool, config, risk } = deps;
  const clock = deps.now ?? (() => new Date());

  return async function register(app) {
    app.post(
      '/v1/authorize',
      {
        /**
         * ORDER MATTERS: authenticate FIRST, then limit.
         *
         * Limiting before authentication would mean counting against a key id
         * an unauthenticated caller chose - so an attacker could exhaust
         * another agent's budget by sending garbage with their key id in it.
         * Denial of service through the rate limiter itself.
         */
        preHandler: [
          requireAgentSignature({ pool, now: clock }),
          agentRateLimit(clock),
        ],
      },
      async (request, reply) => {
        // The guard either set this or already replied 401. Checking again is
        // not paranoia: it makes a future refactor that drops the preHandler a
        // 500 we notice rather than an unauthenticated payment we do not.
        const agent = request.atlAgent;
        if (agent === undefined) {
          request.log.error('authorize reached the handler without an authenticated agent');
          return reply.code(500).send({
            error: 'internal_error',
            message: 'An unexpected error occurred.',
            requestId: request.id,
          });
        }

        const parsed = authorizeBodySchema.safeParse(request.body);
        if (!parsed.success) {
          return reply.code(400).send({
            error: 'validation_failed',
            message: 'The request body is not valid.',
            issues: parsed.error.issues.map((issue) => ({
              field: issue.path.join('.') || '(body)',
              message: issue.message,
            })),
            requestId: request.id,
          });
        }

        const body = parsed.data;
        const now = clock();

        /* --- 1. Idempotency -------------------------------------------- */
        // Checked BEFORE the lock, so a retry storm cannot queue up behind a
        // mandate it is not going to change anyway.
        //
        // This is also our REPLAY defence. The idempotency key is inside the
        // signed string, so a captured request replays to the SAME key and gets
        // the SAME decision back rather than producing a second one. No nonce
        // table is required: UNIQUE (agent_id, idempotency_key) is the nonce
        // store.
        const existing = await findDecisionByIdempotencyKey(
          pool,
          agent.agentId,
          agent.idempotencyKey,
        );

        if (existing !== null) {
          request.log.info(
            { decisionId: existing.decisionId, idempotencyKey: agent.idempotencyKey },
            'idempotent replay: returning the original decision',
          );

          return reply.code(200).send(
            storedToResponse(existing, voucherFor(existing, config, now)),
          );
        }

        /* --- 2. Merchant ------------------------------------------------ */
        const merchant = await loadMerchantMcc(pool, body.merchantId);
        if (merchant === null) {
          return reply.code(404).send({
            error: 'merchant_not_found',
            message: `Merchant ${body.merchantId} is not registered.`,
            requestId: request.id,
          });
        }

        /* --- 3. Lock, read, decide, record - ONE transaction ------------ */
        try {
          const result = await withTransaction(pool, async (tx) => {
            // THE LOCK. Everything after this line sees a spend total that
            // cannot change underneath it, because any other authorization for
            // this mandate is waiting on this row. See repositories/spend.ts.
            const locked = await lockMandateForAuthorization(tx, body.mandateId);
            if (!locked) return { notFound: true as const };

            const loaded = await loadForAuthorization(tx, body.mandateId);
            if (loaded === null) return { notFound: true as const };

            const { mandate, version } = loaded;

            const window = windowBoundsFor(
              version.terms.windowKind,
              now,
              version.terms.timezone,
            );
            const spend = await readSpendSnapshot(tx, body.mandateId, window, now);

            const riskStartedAt = process.hrtime.bigint();
            const riskInput = await risk.score({
              mandateId: body.mandateId,
              agentId: agent.agentId,
              merchantId: body.merchantId,
              merchantMcc: merchant.mcc,
              amountPaise: body.amountPaise,
              spentInWindowPaise: spend.spentInWindowPaise,
              txnsInLastHour: spend.txnsInLastHour,
              now,
            });
            const riskLatencyMs = Number(
              (process.hrtime.bigint() - riskStartedAt) / 1_000_000n,
            );

            /* THE PURE CALL. No database handle, no clock, no network. */
            const startedAt = process.hrtime.bigint();
            const decision = evaluate({
              mandate,
              version,
              attempt: {
                // From the SIGNATURE, never from the body.
                agentId: agent.agentId,
                amountPaise: toPaise(body.amountPaise),
                merchantId: body.merchantId,
                merchantMcc: merchant.mcc,
                paymentMethod: body.paymentMethod,
              },
              spend,
              now,
              risk: riskInput,
            });
            const durationUs = Number((process.hrtime.bigint() - startedAt) / 1_000n);

            const authorizationRequestId = newAuthorizationRequestId();
            const decisionId = newDecisionId();

            await insertAuthorizationRequest(tx, {
              id: authorizationRequestId,
              mandateId: mandate.id,
              mandateVersion: version.version,
              agentId: agent.agentId,
              credentialId: agent.credentialId,
              // Always true here: the preHandler refuses everything else. The
              // column can therefore never be false given our foreign keys -
              // rejected attempts go to the audit chain instead. PHASE_05 §12.
              signatureVerified: true,
              merchantId: body.merchantId,
              amountPaise: body.amountPaise,
              paymentMethod: body.paymentMethod,
              idempotencyKey: agent.idempotencyKey,
              requestId: String(request.id),
              cart: body.cart,
              userIntent: body.userIntent ?? null,
            });

            await insertDecision(tx, {
              id: decisionId,
              authorizationRequestId,
              mandateId: mandate.id,
              mandateVersion: version.version,
              decision,
              spend,
              risk: riskInput,
              durationUs,
            });

            if (riskInput !== null) {
              await insertRiskSignal(tx, {
                id: newRiskSignalId(),
                authorizationRequestId,
                risk: riskInput,
                latencyMs: riskLatencyMs,
              });
            }

            // The audit payload is built from an EXPLICIT ALLOWLIST. Never by
            // spreading the request: an allowlist fails closed, so a field
            // added to the API later stays out of the hashed trail until
            // somebody puts it there deliberately.
            const auditPayload: Record<string, CanonicalValue> = {
              decisionId,
              authorizationRequestId,
              verdict: decision.verdict,
              reason: decision.reason,
              engineVersion: decision.engineVersion,
              mandateId: mandate.id,
              mandateVersion: version.version,
              agentId: agent.agentId,
              credentialFingerprint: agent.fingerprint,
              merchantId: body.merchantId,
              merchantMcc: merchant.mcc,
              amountPaise: body.amountPaise,
              paymentMethod: body.paymentMethod,
              spentBeforePaise: spend.spentInWindowPaise,
              spendWindowStart: spend.windowStart.toISOString(),
              spendWindowEnd: spend.windowEnd.toISOString(),
              txnsInLastHour: spend.txnsInLastHour,
              riskScore: riskInput?.score ?? null,
              riskProvider: riskInput?.provider ?? null,
              evaluations: decision.evaluations.map((item) => ({
                ruleCode: item.ruleCode,
                sequence: item.sequence,
                verdict: item.verdict,
                reason: item.reason,
              })),
              // Recorded even on BLOCK, where it is null. "No voucher was
              // issued" is itself a fact worth attesting.
              voucherJti:
                decision.verdict === 'BLOCK' ? null : voucherJtiFor(decisionId),
              evaluatedAt: decision.evaluatedAt.toISOString(),
            };

            await appendAuditEvent(tx, {
              eventType: 'AUTHORIZATION_DECIDED',
              actorKind: 'agent',
              actorId: agent.agentId,
              subjectKind: 'decision',
              subjectId: decisionId,
              requestId: String(request.id),
              mandateId: mandate.id,
              payload: auditPayload,
            });

            return {
              notFound: false as const,
              decisionId,
              authorizationRequestId,
              decision,
              mandateVersion: version.version,
              riskInput,
            };
          });

          if (result.notFound) {
            return reply.code(404).send({
              error: 'mandate_not_found',
              message: `Mandate ${body.mandateId} does not exist.`,
              requestId: request.id,
            });
          }

          /* --- 4. The voucher - only if the engine said yes ------------- */
          const voucher =
            result.decision.verdict === 'BLOCK'
              ? null
              : mintOne(config, {
                  decisionId: result.decisionId,
                  mandateId: body.mandateId,
                  agentId: agent.agentId,
                  merchantId: body.merchantId,
                  amountPaise: body.amountPaise,
                  verdict: result.decision.verdict,
                  now,
                });

          const response: AuthorizeResponse = {
            decisionId: result.decisionId,
            authorizationRequestId: result.authorizationRequestId,
            verdict: result.decision.verdict,
            reason: result.decision.reason,
            engineVersion: result.decision.engineVersion,
            mandateId: body.mandateId,
            mandateVersion: result.mandateVersion,
            evaluatedAt: result.decision.evaluatedAt.toISOString(),
            evaluations: result.decision.evaluations.map((item) => ({
              ruleCode: item.ruleCode,
              sequence: item.sequence,
              verdict: item.verdict,
              signal: item.signal,
              expected: item.expected,
              actual: item.actual,
              reason: item.reason,
              observedPaise: item.observedPaise,
              limitPaise: item.limitPaise,
            })),
            voucher,
            risk:
              result.riskInput === null
                ? null
                : {
                    provider: result.riskInput.provider,
                    score: result.riskInput.score,
                    band: result.riskInput.band,
                  },
            simulation: SIMULATION_NOTICE,
            idempotentReplay: false,
          };

          request.log.info(
            {
              decisionId: result.decisionId,
              verdict: result.decision.verdict,
              mandateId: body.mandateId,
              agentId: agent.agentId,
              voucherIssued: voucher !== null,
            },
            'authorization decided',
          );

          // 200, not 403, on BLOCK. The decision is the resource and producing
          // it SUCCEEDED; the verdict is the answer, not the error. The real
          // control is structural: a BLOCK carries no voucher. See PHASE_05 §5.
          return reply.code(200).send(response);
        } catch (error) {
          const pgError = error as PgError;

          // Two requests with the same idempotency key raced past the read
          // above and both tried to insert. The UNIQUE constraint caught the
          // second one - which is exactly its job. Resolve by returning the
          // decision that won, so a retry storm still yields ONE decision.
          if (
            pgError.code === UNIQUE_VIOLATION &&
            pgError.constraint === 'authorization_requests_idempotent_per_agent'
          ) {
            const winner = await findDecisionByIdempotencyKey(
              pool,
              agent.agentId,
              agent.idempotencyKey,
            );

            if (winner !== null) {
              request.log.info(
                { decisionId: winner.decisionId },
                'idempotency race resolved by the unique constraint',
              );
              return reply.code(200).send(
                storedToResponse(winner, voucherFor(winner, config, now)),
              );
            }
          }

          throw error;
        }
      },
    );
  };
}

/* ------------------------------------------------------------------------ */
/* Voucher helpers                                                          */
/* ------------------------------------------------------------------------ */

interface MintOneParams {
  readonly decisionId: string;
  readonly mandateId: string;
  readonly agentId: string;
  readonly merchantId: string;
  readonly amountPaise: number;
  readonly verdict: 'PASS' | 'FLAG';
  readonly now: Date;
}

/**
 * Without a signing secret we mint NOTHING and say so.
 *
 * Failing CLOSED is the only safe direction: an unsigned "voucher" that the
 * payment service might accept would be worse than no voucher at all.
 * Production config refuses to boot without the secret (ADR-0011); this is the
 * development path.
 */
function mintOne(config: Config, params: MintOneParams): AuthorizeResponse['voucher'] {
  const secret = config.VOUCHER_SIGNING_SECRET;
  if (secret === undefined) return null;

  const { token, claims } = mintVoucher(secret, params);
  return { token, jti: claims.jti, expiresAt: new Date(claims.exp).toISOString() };
}

/**
 * Re-mint on an idempotent replay.
 *
 * The jti is DERIVED from the decision id, so the replayed voucher carries the
 * same token id as the original. `payments.voucher_jti UNIQUE` therefore still
 * caps the whole decision at one payment however many times it is retried, and
 * `payments.decision_id UNIQUE` caps it again independently.
 */
function voucherFor(
  stored: StoredDecision,
  config: Config,
  now: Date,
): AuthorizeResponse['voucher'] {
  if (stored.verdict === 'BLOCK') return null;

  return mintOne(config, {
    decisionId: stored.decisionId,
    mandateId: stored.mandateId,
    agentId: stored.agentId,
    merchantId: stored.merchantId,
    amountPaise: stored.amountPaise,
    verdict: stored.verdict,
    now,
  });
}

export { VOUCHER_TTL_MS };
