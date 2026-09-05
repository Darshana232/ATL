/**
 * Agent authentication: the real one.
 *
 * This replaces the shared admin key (middleware/admin-auth.ts) for the
 * authorization path. The difference is not cosmetic:
 *
 *   shared key  -> "somebody who knows the key acted".  createdBy is a CLAIM.
 *   signature   -> "the holder of agt_x's private key acted".  It is EVIDENCE.
 *
 * A rejected attempt returns a deliberately uninformative 401. Missing header,
 * malformed header, unknown key, revoked key, suspended agent and bad signature
 * all produce the SAME response body, so probing cannot map our state. The log
 * line and the audit event carry the real reason, keyed by requestId.
 */
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { Pool } from '../db/pool.js';
import { withTransaction } from '../db/transaction.js';
import { appendAuditEvent } from '../audit/writer.js';
import { findCredentialByKeyId, touchCredential } from '../repositories/credential.js';
import {
  buildSigningString,
  checkFreshness,
  hashBody,
  IDEMPOTENCY_HEADER,
  KEY_HEADER,
  SIGNATURE_HEADER,
  TIMESTAMP_HEADER,
  verifySignature,
} from '../auth/signing.js';

export interface AuthenticatedAgent {
  readonly agentId: string;
  readonly credentialId: string;
  readonly keyId: string;
  readonly fingerprint: string;
  readonly idempotencyKey: string;
  /** The verified request timestamp, as sent by the agent. */
  readonly signedAt: Date;
}

/**
 * Fastify request decoration.
 *
 * Module augmentation rather than `(request as any).agent`: the route handler
 * then gets a TYPED, non-optional-after-guard value, and a future refactor that
 * removes this preHandler becomes a compile error instead of a runtime
 * `undefined` in a security check.
 */
declare module 'fastify' {
  interface FastifyRequest {
    atlAgent?: AuthenticatedAgent;
    /** Raw JSON text, captured by the content-type parser in server.ts. */
    rawBody?: string;
  }
}

/** Why we refused. Never sent to the caller; logged and audited. */
type RejectReason =
  | 'missing_headers'
  | 'malformed_header'
  | 'timestamp_malformed'
  | 'timestamp_too_old'
  | 'timestamp_too_new'
  | 'unknown_key'
  | 'credential_revoked'
  | 'credential_expired'
  | 'agent_not_active'
  | 'bad_signature';

/**
 * Header values must be single-line, printable and bounded.
 *
 * WHY: the signing string joins fields with newlines. A header containing a
 * newline could inject an extra line into that string, which is header
 * injection applied to a signature - the same class of bug as CRLF injection in
 * HTTP. Rejecting the character removes the ambiguity at the door.
 *
 * The length cap is a cheap denial-of-service control: we hash and compare
 * these before doing anything else.
 */
const SAFE_HEADER = /^[\x21-\x7e]{1,255}$/;

/**
 * Exported for testing.
 *
 * The `string[]` branch cannot be reached through Fastify's `inject`, which
 * collapses repeated headers before the handler sees them - so an HTTP-level
 * test of it would pass while proving nothing (PHASE_04's lesson). It is
 * proven directly instead. See PHASE_05 section 11.
 */
export function singleHeader(value: unknown): string | null {
  // Fastify gives string[] when a header appears twice. Two X-ATL-Signature
  // headers is never legitimate and is a classic request-smuggling shape, so
  // it is rejected rather than resolved by picking one.
  if (typeof value !== 'string') return null;
  return SAFE_HEADER.test(value) ? value : null;
}

export interface AgentAuthDeps {
  readonly pool: Pool;
  /** Injectable clock, so freshness can be tested without fake timers. */
  readonly now?: () => Date;
}

/**
 * Record a rejected attempt in the hash-chained audit trail.
 *
 * WHY NOT `authorization_requests.signature_verified = false`?
 *
 * That column exists (migration 0004) and was designed for exactly this. But
 * the row it lives on has NOT NULL foreign keys to a mandate, a mandate
 * VERSION and a merchant - and a request whose signature failed may contain
 * nothing valid at all. Writing it would mean either inserting attacker-chosen
 * identifiers or failing the insert on a foreign key, and neither is evidence.
 *
 * The audit chain has no such constraints, is append-only, and is hashed. It is
 * the better home. Recorded as debt in PHASE_05 section 12: with our FKs,
 * `signature_verified` can only ever be true.
 */
async function auditRejection(
  pool: Pool,
  request: FastifyRequest,
  reason: RejectReason,
  agentId: string | null,
  keyId: string | null,
): Promise<void> {
  try {
    await withTransaction(pool, async (tx) => {
      await appendAuditEvent(tx, {
        eventType: 'AGENT_AUTH_REJECTED',
        // 'system' when we could not establish WHO tried. Attributing a
        // rejected attempt to an agent id we never verified would put an
        // attacker's chosen string into the evidence chain.
        actorKind: agentId === null ? 'system' : 'agent',
        actorId: agentId,
        subjectKind: 'agent',
        subjectId: agentId ?? 'unknown',
        requestId: String(request.id),
        payload: {
          reason,
          keyId,
          method: request.method,
          path: request.url,
          // No headers, no body: a rejected request is untrusted input and we
          // are about to hash whatever we store into an append-only table.
        },
      });
    });
  } catch (error) {
    // Auditing the rejection must never turn a 401 into a 500.
    request.log.error({ err: error, reason }, 'failed to audit an auth rejection');
  }
}

export function requireAgentSignature(deps: AgentAuthDeps) {
  const clock = deps.now ?? (() => new Date());

  return async function agentSignatureGuard(
    request: FastifyRequest,
    reply: FastifyReply,
  ): Promise<void> {
    const reject = async (
      reason: RejectReason,
      agentId: string | null = null,
      keyId: string | null = null,
    ): Promise<void> => {
      request.log.warn({ reason, keyId, route: request.url }, 'agent authentication rejected');
      await auditRejection(deps.pool, request, reason, agentId, keyId);

      await reply.code(401).send({
        error: 'unauthorized',
        // One message for every cause. See the file header.
        message:
          'A valid Ed25519 request signature is required. Send X-ATL-Key, ' +
          'X-ATL-Timestamp, X-ATL-Idempotency-Key and X-ATL-Signature.',
        requestId: request.id,
      });
    };

    const keyId = singleHeader(request.headers[KEY_HEADER]);
    const timestamp = singleHeader(request.headers[TIMESTAMP_HEADER]);
    const idempotencyKey = singleHeader(request.headers[IDEMPOTENCY_HEADER]);
    const signature = singleHeader(request.headers[SIGNATURE_HEADER]);

    if (keyId === null || timestamp === null || idempotencyKey === null || signature === null) {
      const anyPresent = [KEY_HEADER, TIMESTAMP_HEADER, IDEMPOTENCY_HEADER, SIGNATURE_HEADER]
        .some((h) => request.headers[h] !== undefined);

      return reject(anyPresent ? 'malformed_header' : 'missing_headers');
    }

    // Checked BEFORE the database lookup, because it costs nothing and an
    // unauthenticated caller should not be able to make us query on demand.
    const freshness = checkFreshness(timestamp, clock());
    if (!freshness.ok) {
      const reason =
        freshness.why === 'malformed'
          ? 'timestamp_malformed'
          : freshness.why === 'too_old'
            ? 'timestamp_too_old'
            : 'timestamp_too_new';
      return reject(reason, null, keyId);
    }

    /**
     * A GET carries no body, so there is nothing for the content-type parser to
     * capture and `rawBody` is undefined. Signing the EMPTY STRING is the
     * well-defined answer, and both sides do the same thing.
     *
     * Found by the first GET /v1/payments/:id test, which returned 401 for a
     * perfectly valid signature: the guard had been written against POST only.
     * `?? ''` rather than skipping the body hash entirely, because the hash must
     * always be present in the signing string - a scheme where one line
     * sometimes disappears is a scheme with two shapes.
     */
    const rawBody = request.rawBody ?? '';

    const credential = await findCredentialByKeyId(deps.pool, keyId);
    if (credential === null) return reject('unknown_key', null, keyId);

    if (credential.credentialStatus !== 'active') {
      return reject('credential_revoked', credential.agentId, keyId);
    }

    // Expiry is COMPUTED from the timestamp rather than trusted from `status`.
    // A stored status needs a scheduled job to stay truthful, and until it runs
    // the row claims to be active while being expired - the same argument as
    // mandate expiry in domain/mandate.ts.
    if (credential.expiresAt !== null && credential.expiresAt.getTime() <= clock().getTime()) {
      return reject('credential_expired', credential.agentId, keyId);
    }

    if (credential.agentStatus !== 'active') {
      // Suspending an AGENT must instantly disable every credential it holds,
      // without anyone having to revoke each key individually.
      return reject('agent_not_active', credential.agentId, keyId);
    }

    const signingString = buildSigningString({
      method: request.method,
      // request.url includes the query string; we sign the path we routed to.
      // Both sides must agree, so this is stated rather than inferred.
      path: request.routeOptions.url ?? request.url,
      timestamp,
      keyId,
      idempotencyKey,
      bodySha256: hashBody(rawBody),
    });

    if (!verifySignature(credential.publicKeySpkiB64, signingString, signature)) {
      return reject('bad_signature', credential.agentId, keyId);
    }

    request.atlAgent = {
      agentId: credential.agentId,
      credentialId: credential.credentialId,
      keyId: credential.keyId,
      fingerprint: credential.fingerprint,
      idempotencyKey,
      signedAt: freshness.at,
    };

    // Telemetry, outside the authorization transaction. A failure here must
    // never fail a payment.
    void touchCredential(deps.pool, credential.credentialId).catch((error: unknown) => {
      request.log.warn({ err: error }, 'could not stamp credential last_used_at');
    });
  };
}
