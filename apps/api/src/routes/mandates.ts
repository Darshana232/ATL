/**
 * Mandate endpoints.
 *
 * Every mutation runs in ONE transaction containing both the domain writes and
 * the audit event, so the trail can never disagree with the data.
 *
 * AUTHENTICATION: the mutating routes sit behind a shared admin key
 * (see middleware/admin-auth.ts). That is a placeholder, replaced in Phase 5
 * by per-agent Ed25519 signatures and in Phase 9 by user sessions with RBAC.
 * Reads are open in Phase 3 and must not stay that way.
 */
import type { FastifyInstance, FastifyPluginAsync } from 'fastify';
import type { Config } from '../config.js';
import type { Pool } from '../db/pool.js';
import { withTransaction } from '../db/transaction.js';
import { appendAuditEvent } from '../audit/writer.js';
import { requireAdminKey } from '../middleware/admin-auth.js';
import {
  InvalidIfscError,
  lookupBankSafely,
  type BankLookupProvider,
} from '../providers/bank-lookup.js';
import {
  addVersionBodySchema,
  createMandateBodySchema,
  mandateToWire,
  revokeMandateBodySchema,
  termsToDomain,
  toValidationErrorBody,
  versionToWire,
} from '../dto/mandate.js';
import {
  insertMandate,
  insertVersion,
  listVersions,
  loadForAuthorization,
  loadVersion,
  newMandateId,
  nextVersionNumber,
  revokeMandate,
} from '../repositories/mandate.js';
import type { MandateTerms } from '../domain/mandate.js';
import type { CanonicalValue } from '../audit/canonical.js';

export interface MandateRoutesDeps {
  readonly pool: Pool;
  readonly config: Config;
  readonly bankLookup: BankLookupProvider;
}

/** PostgreSQL SQLSTATEs we translate into meaningful client errors. */
const FOREIGN_KEY_VIOLATION = '23503';
const UNIQUE_VIOLATION = '23505';
const CHECK_VIOLATION = '23514';
const NOT_NULL_VIOLATION = '23502';

/**
 * Database constraints that a CALLER can trip, mapped to the field they should
 * fix.
 *
 * Found by a live smoke test: a consent timestamp later in the day than the
 * server's clock tripped `mandate_versions_consent_not_after_creation` and
 * surfaced as an opaque 500. Every in-process test happened to use a past
 * timestamp, so nothing caught it. A constraint we deliberately added must
 * produce an explanation, not a stack trace.
 *
 * Anything NOT in this table stays a 500 on purpose - an unmapped constraint
 * failure means our own code built an invalid row, which is our bug and not
 * the caller's.
 */
const CALLER_FIXABLE_CONSTRAINTS: Readonly<Record<string, { field: string; message: string }>> = {
  mandate_versions_consent_not_after_creation: {
    field: 'consentAt',
    message: 'must not be later than the moment the version is created (check your clock/timezone)',
  },
  mandate_versions_consent_ref_not_blank: {
    field: 'consentRef',
    message: 'must not be blank',
  },
  mandate_versions_per_txn_within_window: {
    field: 'terms.perTxnLimitPaise',
    message: 'must not exceed terms.windowLimitPaise',
  },
  mandate_versions_validity_ordered: {
    field: 'terms.validTo',
    message: 'must be after terms.validFrom',
  },
  mandates_id_format: { field: 'mandateId', message: 'is not a valid mandate id' },
  merchants_id_format: { field: 'merchantIds', message: 'contains an invalid merchant id' },
};

type PgError = Error & { code?: string; constraint?: string; detail?: string };

/**
 * Build the audit payload from an EXPLICIT ALLOWLIST of fields.
 *
 * Never by spreading a request object: an allowlist fails closed, so a field
 * added to the API later stays out of the hashed audit trail until someone
 * puts it there deliberately. Spreading would quietly start recording whatever
 * a caller sent - including personal data nobody decided to keep.
 */
function termsForAudit(terms: MandateTerms): Record<string, CanonicalValue> {
  return {
    perTxnLimitPaise: terms.perTxnLimitPaise,
    windowLimitPaise: terms.windowLimitPaise,
    windowKind: terms.windowKind,
    maxTxnPerHour: terms.maxTxnPerHour,
    blockedMccs: [...terms.blockedMccs],
    timezone: terms.timezone,
    windowStartHour: terms.windowStartHour,
    windowEndHour: terms.windowEndHour,
    allowedWeekdays: [...terms.allowedWeekdays],
    validFrom: terms.validFrom.toISOString(),
    validTo: terms.validTo.toISOString(),
    paymentMethods: [...terms.paymentMethods],
    afaExemptionThresholdPaise: terms.afaExemptionThresholdPaise,
  };
}

export function mandateRoutes(deps: MandateRoutesDeps): FastifyPluginAsync {
  const { pool, config, bankLookup } = deps;
  const adminOnly = { preHandler: requireAdminKey(config) };

  return async (app: FastifyInstance): Promise<void> => {
    /* ------------------------------------------------------------------ */
    /* POST /v1/mandates - create a mandate and its version 1              */
    /* ------------------------------------------------------------------ */
    app.post('/v1/mandates', adminOnly, async (request, reply) => {
      const parsed = createMandateBodySchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.code(400).send(toValidationErrorBody(parsed.error));
      }
      const body = parsed.data;

      // Semantic validation lives in the domain; a failure here is a 400 too.
      let terms: MandateTerms;
      try {
        terms = termsToDomain(body.terms);
      } catch (error) {
        const validationBody = toValidationErrorBody(error);
        if (validationBody === null) throw error; // a real bug -> 500
        return reply.code(400).send(validationBody);
      }

      /* --- COLD PATH: optional bank lookup ---------------------------- */
      // Optional, timeout-bounded, and survivable. Never on the authorization
      // path (ADR-0013).
      let bankContext: Record<string, CanonicalValue> | null = null;
      let bankDegraded = false;
      const warnings: string[] = [];

      if (body.ifsc !== undefined) {
        try {
          const outcome = await lookupBankSafely(bankLookup, body.ifsc, request.log);
          bankDegraded = outcome.degraded;

          if (outcome.details !== null) {
            bankContext = {
              ifsc: outcome.details.ifsc,
              bank: outcome.details.bank,
              branch: outcome.details.branch,
              supportsUpi: outcome.details.supportsUpi,
            };

            const wantsUpi = terms.paymentMethods.some((method) => method.startsWith('upi'));
            if (wantsUpi && !outcome.details.supportsUpi) {
              // Advisory, not an error: we do not operate the rail and should
              // not refuse a mandate on a third party's say-so.
              warnings.push(
                `Branch ${outcome.details.ifsc} (${outcome.details.bank}) does not report UPI support, ` +
                  `but this mandate permits a UPI payment method.`,
              );
            }
          } else if (!outcome.degraded) {
            warnings.push(`IFSC ${body.ifsc} was not found.`);
          }

          if (outcome.degraded) {
            warnings.push('Bank lookup was unavailable; the mandate was created without it.');
          }
        } catch (error) {
          // An invalid IFSC is the caller's mistake, not a dependency failure.
          if (error instanceof InvalidIfscError) {
            return reply.code(400).send({
              error: 'validation_failed',
              message: 'Request body is invalid.',
              issues: [{ field: 'ifsc', message: error.message }],
            });
          }
          throw error;
        }
      }

      const mandateId = newMandateId();

      try {
        await withTransaction(pool, async (client) => {
          await insertMandate(client, {
            mandateId,
            userId: body.userId,
            agentId: body.agentId,
            label: body.label,
            terms,
            merchantIds: body.merchantIds,
            createdBy: body.createdBy,
            changeReason: body.changeReason ?? null,
            consentRef: body.consentRef,
            consentAt: new Date(body.consentAt),
          });

          await appendAuditEvent(client, {
            eventType: 'MANDATE_CREATED',
            actorKind: 'admin',
            actorId: body.createdBy,
            subjectKind: 'mandate',
            subjectId: mandateId,
            requestId: String(request.id),
            mandateId,
            payload: {
              mandateId,
              userId: body.userId,
              agentId: body.agentId,
              label: body.label,
              version: 1,
              terms: termsForAudit(terms),
              merchantIds: [...body.merchantIds],
              consentRef: body.consentRef,
              consentAt: body.consentAt,
              changeReason: body.changeReason ?? null,
              bankLookup: bankContext ?? null,
              bankLookupDegraded: bankDegraded,
            },
          });
        });
      } catch (error) {
        const mapped = mapWriteError(error);
        if (mapped !== null) return reply.code(mapped.status).send(mapped.body);
        throw error;
      }

      const created = await loadForAuthorization(pool, mandateId);
      if (created === null) throw new Error('mandate vanished immediately after creation');

      return reply.code(201).send({
        mandate: mandateToWire(created.mandate, created.version),
        bankContext,
        warnings,
      });
    });

    /* ------------------------------------------------------------------ */
    /* GET /v1/mandates/:id                                               */
    /* ------------------------------------------------------------------ */
    app.get<{ Params: { id: string } }>('/v1/mandates/:id', async (request, reply) => {
      const loaded = await loadForAuthorization(pool, request.params.id);

      if (loaded === null) {
        return reply.code(404).send({
          error: 'not_found',
          message: `No mandate with id ${request.params.id}.`,
          requestId: request.id,
        });
      }

      return reply.send({ mandate: mandateToWire(loaded.mandate, loaded.version) });
    });

    /* ------------------------------------------------------------------ */
    /* GET /v1/mandates/:id/versions                                      */
    /* ------------------------------------------------------------------ */
    app.get<{ Params: { id: string } }>('/v1/mandates/:id/versions', async (request, reply) => {
      const versions = await listVersions(pool, request.params.id);

      if (versions.length === 0) {
        return reply.code(404).send({
          error: 'not_found',
          message: `No mandate with id ${request.params.id}.`,
          requestId: request.id,
        });
      }

      return reply.send({ versions: versions.map(versionToWire) });
    });

    /* ------------------------------------------------------------------ */
    /* GET /v1/mandates/:id/versions/:version                             */
    /*                                                                    */
    /* The read the two-table design exists for: re-explaining a past      */
    /* decision against the terms it was actually judged under.            */
    /* ------------------------------------------------------------------ */
    app.get<{ Params: { id: string; version: string } }>(
      '/v1/mandates/:id/versions/:version',
      async (request, reply) => {
        const versionNumber = Number(request.params.version);

        if (!Number.isInteger(versionNumber) || versionNumber < 1) {
          return reply.code(400).send({
            error: 'validation_failed',
            message: 'Request is invalid.',
            issues: [{ field: 'version', message: 'must be a positive whole number' }],
          });
        }

        const version = await loadVersion(pool, request.params.id, versionNumber);

        if (version === null) {
          return reply.code(404).send({
            error: 'not_found',
            message: `No version ${versionNumber} for mandate ${request.params.id}.`,
            requestId: request.id,
          });
        }

        return reply.send({ version: versionToWire(version) });
      },
    );

    /* ------------------------------------------------------------------ */
    /* POST /v1/mandates/:id/versions - supersede the terms               */
    /* ------------------------------------------------------------------ */
    app.post<{ Params: { id: string } }>('/v1/mandates/:id/versions', adminOnly, async (request, reply) => {
      const parsed = addVersionBodySchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.code(400).send(toValidationErrorBody(parsed.error));
      }
      const body = parsed.data;

      let terms: MandateTerms;
      try {
        terms = termsToDomain(body.terms);
      } catch (error) {
        const validationBody = toValidationErrorBody(error);
        if (validationBody === null) throw error;
        return reply.code(400).send(validationBody);
      }

      const existing = await loadForAuthorization(pool, request.params.id);
      if (existing === null) {
        return reply.code(404).send({
          error: 'not_found',
          message: `No mandate with id ${request.params.id}.`,
          requestId: request.id,
        });
      }

      if (existing.mandate.status !== 'active') {
        // Revocation is terminal: a revoked mandate cannot gain new terms.
        // Resuming delegation means issuing a NEW mandate.
        return reply.code(409).send({
          error: 'mandate_revoked',
          message: 'This mandate is revoked; revocation is terminal. Create a new mandate instead.',
          requestId: request.id,
        });
      }

      let version: number;
      try {
        version = await withTransaction(pool, async (client) => {
          const next = await nextVersionNumber(client, request.params.id);

          await insertVersion(client, {
            mandateId: request.params.id,
            version: next,
            terms,
            merchantIds: body.merchantIds,
            createdBy: body.createdBy,
            changeReason: body.changeReason ?? null,
            consentRef: body.consentRef,
            consentAt: new Date(body.consentAt),
          });

          await appendAuditEvent(client, {
            eventType: 'MANDATE_VERSION_ADDED',
            actorKind: 'admin',
            actorId: body.createdBy,
            subjectKind: 'mandate_version',
            subjectId: `${request.params.id}:${next}`,
            requestId: String(request.id),
            mandateId: request.params.id,
            payload: {
              mandateId: request.params.id,
              version: next,
              supersedes: existing.version.version,
              terms: termsForAudit(terms),
              merchantIds: [...body.merchantIds],
              consentRef: body.consentRef,
              consentAt: body.consentAt,
              changeReason: body.changeReason ?? null,
            },
          });

          return next;
        });
      } catch (error) {
        const mapped = mapWriteError(error);
        if (mapped !== null) return reply.code(mapped.status).send(mapped.body);
        throw error;
      }

      const created = await loadVersion(pool, request.params.id, version);
      if (created === null) throw new Error('version vanished immediately after creation');

      return reply.code(201).send({ version: versionToWire(created) });
    });

    /* ------------------------------------------------------------------ */
    /* POST /v1/mandates/:id/revoke                                       */
    /* ------------------------------------------------------------------ */
    app.post<{ Params: { id: string } }>('/v1/mandates/:id/revoke', adminOnly, async (request, reply) => {
      const parsed = revokeMandateBodySchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.code(400).send(toValidationErrorBody(parsed.error));
      }
      const body = parsed.data;

      const existing = await loadForAuthorization(pool, request.params.id);
      if (existing === null) {
        return reply.code(404).send({
          error: 'not_found',
          message: `No mandate with id ${request.params.id}.`,
          requestId: request.id,
        });
      }

      const revoked = await withTransaction(pool, async (client) => {
        const didRevoke = await revokeMandate(client, {
          mandateId: request.params.id,
          revokedBy: body.revokedBy,
          revokedReason: body.revokedReason,
        });

        // Only record an event if something actually changed. An audit trail
        // full of no-op "revoked" entries would misrepresent what happened.
        if (didRevoke) {
          await appendAuditEvent(client, {
            eventType: 'MANDATE_REVOKED',
            actorKind: 'admin',
            actorId: body.revokedBy,
            subjectKind: 'mandate',
            subjectId: request.params.id,
            requestId: String(request.id),
            mandateId: request.params.id,
            payload: {
              mandateId: request.params.id,
              revokedBy: body.revokedBy,
              revokedReason: body.revokedReason,
              versionAtRevocation: existing.version.version,
            },
          });
        }

        return didRevoke;
      });

      if (!revoked) {
        return reply.code(409).send({
          error: 'already_revoked',
          message: 'This mandate was already revoked. Revocation is terminal.',
          requestId: request.id,
        });
      }

      const after = await loadForAuthorization(pool, request.params.id);
      if (after === null) throw new Error('mandate vanished immediately after revocation');

      return reply.send({ mandate: mandateToWire(after.mandate, after.version) });
    });
  };
}

/**
 * Translate a database constraint failure into a meaningful client error.
 *
 * Without this a caller referencing a user that does not exist gets an opaque
 * 500 and has to guess. Returns null for anything unrecognised, so a genuine
 * bug still surfaces as a 500 rather than being mislabelled a client error.
 */
function mapWriteError(
  error: unknown,
): { status: number; body: Record<string, unknown> } | null {
  const pgError = error as PgError;

  if (pgError.code === FOREIGN_KEY_VIOLATION) {
    const field = pgError.constraint?.includes('user')
      ? 'userId'
      : pgError.constraint?.includes('agent')
        ? 'agentId'
        : pgError.constraint?.includes('merchant')
          ? 'merchantIds'
          : '(reference)';

    return {
      status: 400,
      body: {
        error: 'validation_failed',
        message: 'A referenced record does not exist.',
        issues: [{ field, message: 'refers to a record that does not exist' }],
      },
    };
  }

  if (pgError.code === UNIQUE_VIOLATION) {
    return {
      status: 409,
      body: { error: 'conflict', message: 'That record already exists.' },
    };
  }

  if (pgError.code === CHECK_VIOLATION || pgError.code === NOT_NULL_VIOLATION) {
    const known = pgError.constraint === undefined
      ? undefined
      : CALLER_FIXABLE_CONSTRAINTS[pgError.constraint];

    // Unmapped constraint failures fall through to a 500 deliberately: they
    // mean OUR code built an invalid row, which is not something the caller
    // can fix and should not be presented as their mistake.
    if (known !== undefined) {
      return {
        status: 400,
        body: {
          error: 'validation_failed',
          message: 'Request body is invalid.',
          issues: [known],
        },
      };
    }
  }

  return null;
}
