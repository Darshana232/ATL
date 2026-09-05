/**
 * Audit endpoints: verification, reading, and checkpointing.
 *
 * `GET /v1/audit/verify` is the one that matters. It turns "tamper-evident"
 * from a sentence in a README into something anybody can request and check.
 *
 * ACCESS: all three require the admin key. The audit trail contains merchant
 * names, amounts, mandate ids and - in `user_intent` - personal data. Phase 3
 * left mandate READS open; this phase does not add more open reads. Real RBAC
 * is Phase 9.
 */
import type { FastifyPluginAsync } from 'fastify';
import type { Config } from '../config.js';
import type { Pool } from '../db/pool.js';
import { withTransaction } from '../db/transaction.js';
import { requireRole } from '../middleware/session-auth.js';
import { verifyChain, TAMPER_EVIDENT_NOTICE } from '../audit/verifier.js';
import { signCheckpoint } from '../audit/checkpoint.js';
import { appendAuditEvent, DEFAULT_CHAIN_ID } from '../audit/writer.js';
import {
  insertCheckpoint,
  latestCheckpoint,
  listEvents,
  newCheckpointId,
  summariseChain,
} from '../repositories/audit.js';

export interface AuditRoutesDeps {
  readonly pool: Pool;
  readonly config: Config;
  readonly now?: () => Date;
}

const UNIQUE_VIOLATION = '23505';
type PgError = Error & { code?: string; constraint?: string };

/** Chain ids are ours, not free text from a caller. */
const CHAIN_ID_PATTERN = /^[a-z0-9_]{1,64}$/;

export function auditRoutes(deps: AuditRoutesDeps): FastifyPluginAsync {
  const { pool, config } = deps;
  const clock = deps.now ?? (() => new Date());
  // Verifying and reading the chain is a viewer action. CREATING a checkpoint
  // writes a signed anchor that later verifications are judged against, so it
  // is an admin action.
  const adminOnly = { preHandler: requireRole({ pool, config, now: clock }, 'viewer') };
  const canAnchor = { preHandler: requireRole({ pool, config, now: clock }, 'admin') };

  return async function register(app) {
    /* --------------------------------------------------------------------
     * GET /v1/audit/verify
     * ------------------------------------------------------------------ */
    app.get<{ Querystring: { chainId?: string } }>(
      '/v1/audit/verify',
      adminOnly,
      async (request, reply) => {
        const chainId = request.query.chainId ?? DEFAULT_CHAIN_ID;

        if (!CHAIN_ID_PATTERN.test(chainId)) {
          return reply.code(400).send({
            error: 'validation_failed',
            message: 'chainId must be lowercase letters, digits or underscores.',
            requestId: request.id,
          });
        }

        const startedAt = process.hrtime.bigint();
        const result = await verifyChain(pool, {
          chainId,
          checkpointSecret: config.AUDIT_CHECKPOINT_SECRET,
          now: clock(),
        });
        const durationMs = Number((process.hrtime.bigint() - startedAt) / 1_000_000n);

        // A broken chain is a real security event and must be loud in the logs,
        // not merely a field in a response body somebody may never read.
        if (result.status === 'broken') {
          request.log.error(
            { chainId, firstBreak: result.firstBreak, checkpoints: result.checkpoints },
            'AUDIT CHAIN INTEGRITY FAILURE',
          );
        }

        // 200 for both outcomes: the verification RAN and produced an answer.
        // Same reasoning as a BLOCK returning 200 (ADR-0016) - the status code
        // describes the request, the body describes the finding.
        return reply.code(200).send({ ...result, durationMs });
      },
    );

    /* --------------------------------------------------------------------
     * GET /v1/audit/events
     * ------------------------------------------------------------------ */
    app.get<{
      Querystring: {
        chainId?: string; mandateId?: string; eventType?: string;
        beforeSeq?: string; limit?: string;
      };
    }>('/v1/audit/events', adminOnly, async (request, reply) => {
      const { chainId = DEFAULT_CHAIN_ID, mandateId, eventType, beforeSeq, limit } = request.query;

      if (!CHAIN_ID_PATTERN.test(chainId)) {
        return reply.code(400).send({
          error: 'validation_failed',
          message: 'chainId must be lowercase letters, digits or underscores.',
          requestId: request.id,
        });
      }

      const events = await listEvents(pool, {
        chainId,
        mandateId: mandateId ?? null,
        eventType: eventType ?? null,
        beforeSeq: beforeSeq === undefined ? null : Number(beforeSeq),
        limit: limit === undefined ? undefined : Number(limit),
      });

      return reply.code(200).send({
        chainId,
        events: events.map((event) => ({
          seq: event.seq,
          id: event.id,
          eventType: event.eventType,
          occurredAt: event.occurredAt.toISOString(),
          actorKind: event.actorKind,
          actorId: event.actorId,
          subjectKind: event.subjectKind,
          subjectId: event.subjectId,
          requestId: event.requestId,
          mandateId: event.mandateId,
          payload: event.payload,
          payloadHash: event.payloadHash,
          prevHash: event.prevHash,
          hash: event.hash,
        })),
        // Keyset cursor. OFFSET would make deep pages progressively slower and
        // would skip or repeat rows as new events are appended underneath.
        nextBeforeSeq: events.length === 0 ? null : events[events.length - 1]!.seq,
      });
    });

    /* --------------------------------------------------------------------
     * POST /v1/audit/checkpoint
     * ------------------------------------------------------------------ */
    app.post<{ Body?: { chainId?: string; createdBy?: string } }>(
      '/v1/audit/checkpoint',
      canAnchor,
      async (request, reply) => {
        const chainId = request.body?.chainId ?? DEFAULT_CHAIN_ID;
        const createdBy = request.body?.createdBy ?? 'admin';

        if (!CHAIN_ID_PATTERN.test(chainId)) {
          return reply.code(400).send({
            error: 'validation_failed',
            message: 'chainId must be lowercase letters, digits or underscores.',
            requestId: request.id,
          });
        }

        const secret = config.AUDIT_CHECKPOINT_SECRET;
        if (secret === undefined) {
          // FAIL CLOSED. An unsigned "checkpoint" would be an anchor anyone
          // could forge, which is worse than having no anchor: it would make
          // the verification report look reassuring while proving nothing.
          return reply.code(503).send({
            error: 'checkpoints_unavailable',
            message: 'AUDIT_CHECKPOINT_SECRET is not configured, so no anchor can be signed.',
            requestId: request.id,
          });
        }

        // VERIFY BEFORE ANCHORING. Signing a checkpoint over a chain that is
        // already broken would give a forged history our own signature - it
        // would launder the tampering rather than detect it.
        const verification = await verifyChain(pool, {
          chainId, checkpointSecret: secret, now: clock(),
        });

        if (verification.status === 'broken') {
          return reply.code(409).send({
            error: 'chain_broken',
            message:
              'The chain does not currently verify, so it must not be anchored. ' +
              'Signing a checkpoint over a broken chain would certify the damage.',
            firstBreak: verification.firstBreak,
            requestId: request.id,
          });
        }

        const summary = await summariseChain(pool, chainId);
        if (summary.headSeq === null || summary.headHash === null) {
          return reply.code(409).send({
            error: 'chain_empty',
            message: 'There is nothing to anchor: this chain has no events.',
            requestId: request.id,
          });
        }

        const createdAt = clock().toISOString();
        const facts = {
          chainId,
          seq: summary.headSeq,
          headHash: summary.headHash,
          eventCount: summary.eventCount,
          createdAt,
        };

        const checkpoint = {
          ...facts,
          id: newCheckpointId(),
          signature: signCheckpoint(secret, facts),
          createdBy,
        };

        try {
          await withTransaction(pool, async (tx) => {
            await insertCheckpoint(tx, checkpoint);

            // The checkpoint's own creation is an audited event. It lands AFTER
            // the anchored head, so it is covered by the NEXT checkpoint - the
            // chain keeps a record of who anchored it and when.
            await appendAuditEvent(tx, {
              eventType: 'AUDIT_CHECKPOINT_CREATED',
              actorKind: 'admin',
              actorId: createdBy,
              subjectKind: 'audit',
              subjectId: checkpoint.id,
              requestId: String(request.id),
              chainId,
              payload: {
                checkpointId: checkpoint.id,
                chainId,
                seq: checkpoint.seq,
                headHash: checkpoint.headHash,
                eventCount: checkpoint.eventCount,
                createdAt,
              },
            });
          });
        } catch (error) {
          const pgError = error as PgError;

          if (
            pgError.code === UNIQUE_VIOLATION &&
            pgError.constraint === 'audit_checkpoints_one_per_position'
          ) {
            // Two anchors claiming different head hashes at the same position
            // would make the anchor ambiguous, and an ambiguous anchor anchors
            // nothing. The existing one stands.
            const existing = await latestCheckpoint(pool, chainId);
            return reply.code(409).send({
              error: 'checkpoint_exists',
              message: `This chain is already anchored at seq ${summary.headSeq}.`,
              checkpoint: existing,
              requestId: request.id,
            });
          }

          throw error;
        }

        request.log.info(
          { checkpointId: checkpoint.id, chainId, seq: checkpoint.seq },
          'audit checkpoint created',
        );

        return reply.code(201).send({
          checkpoint: {
            id: checkpoint.id,
            chainId,
            seq: checkpoint.seq,
            headHash: checkpoint.headHash,
            eventCount: checkpoint.eventCount,
            createdAt,
            createdBy,
            signatureAlgorithm: 'hmac-sha256',
          },
          limitation: TAMPER_EVIDENT_NOTICE,
        });
      },
    );
  };
}
