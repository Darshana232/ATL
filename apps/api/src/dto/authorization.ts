/**
 * Wire schemas for the authorization endpoint.
 *
 * Same division of labour as dto/mandate.ts: Zod owns SHAPE and FORMAT, the
 * domain and the engine own MEANING. Nothing here decides whether a payment is
 * allowed - it only decides whether the request is well formed enough to be
 * evaluated at all.
 *
 * NOTE WHAT IS *NOT* IN THE BODY: the agent id. It comes from signature
 * verification, never from the caller. A body-supplied agent id would let any
 * signer claim to be any agent, which would make MANDATE_AGENT_MATCH compare a
 * claim against a claim.
 */
import { z } from 'zod';
import { MAX_SAFE_PAISE } from '../money.js';
import { PAYMENT_METHODS } from '../domain/mandate.js';
import type { Decision, RuleEvaluation } from '../policy/types.js';

const idSchema = (prefix: string) =>
  z
    .string()
    .regex(
      new RegExp(`^${prefix}_[a-z0-9_]{2,40}$`),
      `must be an id of the form ${prefix}_…`,
    );

/**
 * One cart line. Bounded on every axis - name length, quantity, price - because
 * this object is stored as JSONB and later rendered in a dashboard. Unbounded
 * strings from an untrusted caller become a storage problem and then an XSS
 * problem.
 */
const cartItemSchema = z.strictObject({
  sku: z.string().trim().min(1).max(64),
  name: z.string().trim().min(1).max(200),
  quantity: z.int().positive().max(1_000),
  unitPricePaise: z.int().positive().max(MAX_SAFE_PAISE),
});

export const authorizeBodySchema = z.strictObject({
  mandateId: idSchema('mnd'),
  merchantId: idSchema('mer'),

  amountPaise: z
    .int('must be a whole number of paise')
    .positive('must be greater than zero')
    .max(MAX_SAFE_PAISE),

  paymentMethod: z.enum(PAYMENT_METHODS),

  /** At most 100 lines. The cart is evidence, not a bulk-upload channel. */
  cart: z.array(cartItemSchema).max(100).optional(),

  /**
   * The user's natural-language instruction.
   *
   * DPDP: personal data. Optional, capped, and recorded in the Phase 8
   * processing register with an explicit purpose (dispute resolution and
   * explainability) rather than collected by default and justified afterwards.
   */
  userIntent: z.string().trim().max(2_000).optional(),
});

export type AuthorizeBody = z.infer<typeof authorizeBodySchema>;

/* ------------------------------------------------------------------------ */
/* Response                                                                 */
/* ------------------------------------------------------------------------ */

export interface RuleEvaluationResponse {
  readonly ruleCode: string;
  readonly sequence: number;
  readonly verdict: string;
  readonly signal: string;
  readonly expected: string;
  readonly actual: string;
  readonly reason: string;
  readonly observedPaise: number | null;
  readonly limitPaise: number | null;
}

export interface AuthorizeResponse {
  readonly decisionId: string;
  readonly authorizationRequestId: string;
  readonly verdict: string;
  readonly reason: string;
  readonly engineVersion: string;
  readonly mandateId: string;
  readonly mandateVersion: number;
  readonly evaluatedAt: string;
  readonly evaluations: readonly RuleEvaluationResponse[];
  /**
   * NULL ON BLOCK, and that is the security control.
   *
   * A caller that ignores `verdict` entirely still cannot pay, because there is
   * no token to present to the payment service. The safety does not depend on
   * the client reading the answer correctly - which is the only kind of safety
   * worth relying on.
   */
  readonly voucher: {
    readonly token: string;
    readonly jti: string;
    readonly expiresAt: string;
  } | null;
  readonly risk: { readonly provider: string; readonly score: number; readonly band: string } | null;
  /** Honest labelling: this rail is simulated. Never dropped from a response. */
  readonly simulation: string;
  /** True when this response replays a decision made by an earlier request. */
  readonly idempotentReplay: boolean;
}

export function evaluationToWire(item: RuleEvaluation): RuleEvaluationResponse {
  return {
    ruleCode: item.ruleCode,
    sequence: item.sequence,
    verdict: item.verdict,
    signal: item.signal,
    expected: item.expected,
    actual: item.actual,
    reason: item.reason,
    observedPaise: item.observedPaise,
    limitPaise: item.limitPaise,
  };
}

export function decisionToWire(decision: Decision): Pick<
  AuthorizeResponse,
  'verdict' | 'reason' | 'engineVersion' | 'evaluatedAt' | 'evaluations'
> {
  return {
    verdict: decision.verdict,
    reason: decision.reason,
    engineVersion: decision.engineVersion,
    evaluatedAt: decision.evaluatedAt.toISOString(),
    evaluations: decision.evaluations.map(evaluationToWire),
  };
}
