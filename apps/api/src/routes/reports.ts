/**
 * Compliance report endpoints.
 *
 * Three reports, all admin-key guarded, all carrying their own honesty caveat
 * as a REQUIRED FIELD rather than as documentation. A caveat that lives only in
 * a README gets separated from the number the first time somebody takes a
 * screenshot.
 */
import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import type { Config } from '../config.js';
import type { Pool } from '../db/pool.js';
import { withTransaction } from '../db/transaction.js';
import { appendAuditEvent } from '../audit/writer.js';
import { requireRole } from '../middleware/session-auth.js';
import { buildCoverageReport } from '../reports/free-ai.js';
import { buildStrDraft } from '../reports/str.js';
import { buildDpdpRegister } from '../reports/dpdp.js';
import {
  findReport, insertReport, listReports, newReportId, reviewReport,
  type ReportKind,
} from '../repositories/report.js';

export interface ReportRoutesDeps {
  readonly pool: Pool;
  readonly config: Config;
  readonly now?: () => Date;
}

const periodSchema = z.object({
  periodStart: z.iso.datetime().optional(),
  periodEnd: z.iso.datetime().optional(),
});

const reviewBodySchema = z.strictObject({
  // 'filed' is absent, here and in the database. There is no path to it.
  status: z.enum(['UNDER_REVIEW', 'READY_FOR_FILING', 'REJECTED']),
  reviewedBy: z.string().trim().min(1).max(200),
  note: z.string().trim().max(2000).optional(),
});

export function reportRoutes(deps: ReportRoutesDeps): FastifyPluginAsync {
  const { pool, config } = deps;
  const clock = deps.now ?? (() => new Date());
  // Reading a report is a viewer action. GENERATING one creates a stored,
  // hashed compliance artefact, and REVIEWING one advances a workflow a human
  // signs - both are compliance-role actions.
  const canRead = { preHandler: requireRole({ pool, config, now: clock }, 'viewer') };
  const canReview = { preHandler: requireRole({ pool, config, now: clock }, 'compliance') };

  return async function register(app) {
    /** Parse an optional reporting period from the query string. */
    const periodOf = (query: unknown) => {
      const parsed = periodSchema.safeParse(query ?? {});
      if (!parsed.success) return null;

      return {
        periodStart: parsed.data.periodStart === undefined
          ? undefined : new Date(parsed.data.periodStart),
        periodEnd: parsed.data.periodEnd === undefined
          ? undefined : new Date(parsed.data.periodEnd),
        now: clock(),
      };
    };

    app.get('/v1/reports/free-ai', canRead, async (request, reply) => {
      const period = periodOf(request.query);
      if (period === null) {
        return reply.code(400).send({ error: 'validation_failed', requestId: request.id });
      }

      return reply.code(200).send(await buildCoverageReport(pool, period));
    });

    app.get('/v1/reports/str', canRead, async (request, reply) => {
      const period = periodOf(request.query);
      if (period === null) {
        return reply.code(400).send({ error: 'validation_failed', requestId: request.id });
      }

      return reply.code(200).send(await buildStrDraft(pool, period));
    });

    app.get('/v1/reports/dpdp', canRead, async (request, reply) => {
      const period = periodOf(request.query);
      if (period === null) {
        return reply.code(400).send({ error: 'validation_failed', requestId: request.id });
      }

      return reply.code(200).send(await buildDpdpRegister(pool, period));
    });

    /* ------------------------------------------------------------------
     * Persist a report.
     * ---------------------------------------------------------------- */
    app.post<{ Params: { kind: string }; Body?: { generatedBy?: string } }>(
      '/v1/reports/:kind/generate',
      canReview,
      async (request, reply) => {
        const kinds: Record<string, ReportKind> = {
          'free-ai': 'free_ai_coverage', str: 'str_draft', dpdp: 'dpdp_register',
        };
        const kind = kinds[request.params.kind];

        if (kind === undefined) {
          return reply.code(404).send({
            error: 'unknown_report',
            message: 'Report kind must be one of: free-ai, str, dpdp.',
            requestId: request.id,
          });
        }

        const period = periodOf(request.query) ?? { now: clock() };
        const now = clock();

        const body =
          kind === 'free_ai_coverage' ? await buildCoverageReport(pool, period)
          : kind === 'str_draft' ? await buildStrDraft(pool, period)
          : await buildDpdpRegister(pool, period);

        const id = newReportId();
        // The VERIFIED identity, not a caller-supplied string. This is the
        // whole point of ATL-C22: `generatedBy` used to record a claim.
        const actor = request.principal!;
        const generatedBy = actor.kind === 'operator'
          ? actor.id
          : (request.body?.generatedBy ?? 'shared_admin_key');

        const bodyHash = await withTransaction(pool, async (tx) => {
          const hash = await insertReport(tx, {
            id, kind,
            periodStart: new Date(body.periodStart),
            periodEnd: new Date(body.periodEnd),
            body, generatedBy,
          });

          // Generating a report is itself an audited action. "Who ran the
          // compliance report, and when, over what period" is a question an
          // auditor asks about the auditor.
          await appendAuditEvent(tx, {
            eventType: 'REPORT_GENERATED',
            actorKind: 'admin',
            actorId: generatedBy,
            subjectKind: 'report',
            subjectId: id,
            requestId: String(request.id),
            payload: {
              reportId: id, kind,
              periodStart: body.periodStart, periodEnd: body.periodEnd,
              bodyHash: hash,
              generatedAt: now.toISOString(),
            },
          });

          return hash;
        });

        return reply.code(201).send({
          id, kind, status: 'DRAFT', bodyHash,
          periodStart: body.periodStart, periodEnd: body.periodEnd,
          body,
        });
      },
    );

    app.get<{ Querystring: { kind?: string; limit?: string } }>(
      '/v1/reports',
      canRead,
      async (request, reply) => {
        const kind = request.query.kind as ReportKind | undefined;
        const reports = await listReports(pool, {
          kind,
          limit: request.query.limit === undefined ? undefined : Number(request.query.limit),
        });

        return reply.code(200).send({
          reports: reports.map((report) => ({
            id: report.id, kind: report.kind, status: report.status,
            periodStart: report.periodStart.toISOString(),
            periodEnd: report.periodEnd.toISOString(),
            bodyHash: report.bodyHash,
            generatedBy: report.generatedBy,
            generatedAt: report.generatedAt.toISOString(),
            reviewedBy: report.reviewedBy,
            reviewedAt: report.reviewedAt?.toISOString() ?? null,
          })),
        });
      },
    );

    app.get<{ Params: { id: string } }>(
      '/v1/reports/detail/:id',
      canRead,
      async (request, reply) => {
        const report = await findReport(pool, request.params.id);

        if (report === null) {
          return reply.code(404).send({ error: 'report_not_found', requestId: request.id });
        }

        return reply.code(200).send({
          ...report,
          periodStart: report.periodStart.toISOString(),
          periodEnd: report.periodEnd.toISOString(),
          generatedAt: report.generatedAt.toISOString(),
          reviewedAt: report.reviewedAt?.toISOString() ?? null,
        });
      },
    );

    /* ------------------------------------------------------------------
     * Human review. The workflow STOPS at READY_FOR_FILING.
     * ---------------------------------------------------------------- */
    app.post<{ Params: { id: string } }>(
      '/v1/reports/detail/:id/review',
      canReview,
      async (request, reply) => {
        const parsed = reviewBodySchema.safeParse(request.body);

        if (!parsed.success) {
          return reply.code(400).send({
            error: 'validation_failed',
            issues: parsed.error.issues.map((issue) => ({
              field: issue.path.join('.') || '(body)', message: issue.message,
            })),
            requestId: request.id,
          });
        }

        const report = await findReport(pool, request.params.id);
        if (report === null) {
          return reply.code(404).send({ error: 'report_not_found', requestId: request.id });
        }

        try {
          await withTransaction(pool, async (tx) => {
            await reviewReport(tx, report.id, {
              status: parsed.data.status,
              reviewedBy: parsed.data.reviewedBy,
              note: parsed.data.note ?? null,
            });

            await appendAuditEvent(tx, {
              eventType: 'REPORT_REVIEWED',
              actorKind: 'admin',
              actorId: parsed.data.reviewedBy,
              subjectKind: 'report',
              subjectId: report.id,
              requestId: String(request.id),
              payload: {
                reportId: report.id, kind: report.kind,
                from: report.status, to: parsed.data.status,
                reviewedBy: parsed.data.reviewedBy,
                note: parsed.data.note ?? null,
                // Repeated in the evidence itself, so nobody reading the audit
                // trail alone can mistake a review for a filing.
                note2: 'READY_FOR_FILING does not mean filed. ATL-India cannot file.',
              },
            });
          });
        } catch (error) {
          // ATL02 is our illegal-transition SQLSTATE.
          if ((error as { code?: string }).code === 'ATL02') {
            return reply.code(409).send({
              error: 'illegal_transition',
              message:
                `A report cannot go from ${report.status} to ${parsed.data.status}. ` +
                `DRAFT -> UNDER_REVIEW -> READY_FOR_FILING, or REJECTED at either step.`,
              requestId: request.id,
            });
          }
          throw error;
        }

        return reply.code(200).send({
          id: report.id,
          status: parsed.data.status,
          reviewedBy: parsed.data.reviewedBy,
          note:
            parsed.data.status === 'READY_FOR_FILING'
              ? 'Marked ready for filing. ATL-India does NOT file: a registered ' +
                'reporting entity must submit this through FINnet themselves.'
              : null,
        });
      },
    );
  };
}
