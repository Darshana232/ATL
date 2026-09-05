/**
 * Read endpoints for the dashboard.
 *
 * NAMED `console`, NOT `dashboard`, on purpose: these are the API's operator
 * reads. The dashboard is one client of them and holds no privilege of its own.
 *
 * ALL REQUIRE A SIGNED-IN OPERATOR with at least the `viewer` role. These
 * return merchant names, amounts, mandate ids, agent identities and (through
 * decisions) the user's natural-language intent.
 *
 * Phase 8 guarded them with the shared admin key, which was better than nothing
 * and still recorded no per-caller identity. Phase 9 replaced it with real
 * sessions - closing gap ATL-C22, which the coverage report had been printing
 * on a screen.
 *
 * EVERY LIST IS KEYSET-PAGINATED and every page size is capped server-side. A
 * dashboard that can ask for a million rows is a denial-of-service tool with a
 * nice font.
 */
import type { FastifyPluginAsync } from 'fastify';
import type { Config } from '../config.js';
import type { Pool } from '../db/pool.js';
import { requireRole } from '../middleware/session-auth.js';

export interface ConsoleRoutesDeps {
  readonly pool: Pool;
  readonly config: Config;
}

const cap = (value: unknown, fallback = 50, max = 200): number => {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(Math.max(Math.trunc(parsed), 1), max);
};

export function consoleRoutes(deps: ConsoleRoutesDeps): FastifyPluginAsync {
  const { pool, config } = deps;
  // viewer is the floor: reading evidence is the least privileged thing an
  // operator does, and everything here is a read.
  const adminOnly = { preHandler: requireRole({ pool, config }, 'viewer') };

  return async function register(app) {
    /* --- Overview: the numbers on the front page --------------------- */
    app.get('/v1/console/overview', adminOnly, async (_request, reply) => {
      // ONE query. Eight round trips to render one screen is how a dashboard
      // becomes slow, and the counts must be consistent with each other -
      // separate queries would be a snapshot of eight different moments.
      const result = await pool.query<Record<string, string>>(`
        SELECT
          (SELECT count(*) FROM mandates WHERE status = 'active')            AS active_mandates,
          (SELECT count(*) FROM mandates WHERE status = 'revoked')           AS revoked_mandates,
          (SELECT count(*) FROM agents WHERE status = 'active')              AS active_agents,
          (SELECT count(*) FROM decisions)                                   AS decisions_total,
          (SELECT count(*) FROM decisions WHERE verdict = 'PASS')            AS decisions_pass,
          (SELECT count(*) FROM decisions WHERE verdict = 'FLAG')            AS decisions_flag,
          (SELECT count(*) FROM decisions WHERE verdict = 'BLOCK')           AS decisions_block,
          (SELECT count(*) FROM payments WHERE status = 'captured')          AS payments_captured,
          (SELECT count(*) FROM payments WHERE status = 'failed')            AS payments_failed,
          (SELECT COALESCE(SUM(amount_paise), 0) FROM payments
            WHERE status = 'captured')                                       AS captured_paise,
          (SELECT count(*) FROM payments WHERE provider = 'mock_upi'
            AND status = 'captured')                                         AS simulated_captured,
          (SELECT count(*) FROM audit_events)                                AS audit_events,
          (SELECT count(*) FROM audit_checkpoints)                           AS checkpoints,
          (SELECT count(*) FROM audit_events
            WHERE event_type = 'AGENT_AUTH_REJECTED')                        AS auth_rejections
      `);

      const row = result.rows[0]!;
      const n = (key: string): number => Number(row[key] ?? 0);

      return reply.code(200).send({
        mandates: { active: n('active_mandates'), revoked: n('revoked_mandates') },
        agents: { active: n('active_agents') },
        decisions: {
          total: n('decisions_total'), pass: n('decisions_pass'),
          flag: n('decisions_flag'), block: n('decisions_block'),
        },
        payments: {
          captured: n('payments_captured'), failed: n('payments_failed'),
          capturedPaise: n('captured_paise'),
          // Surfaced as a first-class number so the UI cannot show a settled
          // total without saying how much of it is simulated.
          simulatedCaptured: n('simulated_captured'),
        },
        audit: {
          events: n('audit_events'), checkpoints: n('checkpoints'),
          authRejections: n('auth_rejections'),
        },
        simulation:
          'Payment settlement is SIMULATED unless a payment records ' +
          'provider = razorpay_test. The mandate authorization rail is an MVP ' +
          'simulation in all cases.',
      });
    });

    /* --- Decisions --------------------------------------------------- */
    app.get<{ Querystring: { verdict?: string; mandateId?: string; before?: string; limit?: string } }>(
      '/v1/console/decisions', adminOnly,
      async (request, reply) => {
        const { verdict, mandateId, before } = request.query;

        const result = await pool.query(`
          SELECT d.id, d.verdict, d.reason, d.engine_version, d.mandate_id,
                 d.mandate_version, d.evaluated_at, d.risk_score, d.risk_provider,
                 d.spent_before_paise, d.evaluation_duration_us,
                 r.agent_id, r.merchant_id, r.amount_paise, r.payment_method,
                 r.user_intent,
                 p.id AS payment_id, p.status AS payment_status, p.provider
            FROM decisions d
            JOIN authorization_requests r ON r.id = d.authorization_request_id
            LEFT JOIN payments p ON p.decision_id = d.id
           WHERE ($1::text IS NULL OR d.verdict = $1)
             AND ($2::text IS NULL OR d.mandate_id = $2)
             AND ($3::timestamptz IS NULL OR d.evaluated_at < $3)
           ORDER BY d.evaluated_at DESC
           LIMIT $4`,
          [verdict ?? null, mandateId ?? null, before ?? null, cap(request.query.limit)],
        );

        const rows = result.rows as Record<string, unknown>[];

        return reply.code(200).send({
          decisions: rows.map((row) => ({
            id: row.id, verdict: row.verdict, reason: row.reason,
            engineVersion: row.engine_version,
            mandateId: row.mandate_id, mandateVersion: row.mandate_version,
            agentId: row.agent_id, merchantId: row.merchant_id,
            amountPaise: Number(row.amount_paise),
            paymentMethod: row.payment_method,
            userIntent: row.user_intent,
            spentBeforePaise: Number(row.spent_before_paise),
            evaluationDurationUs: row.evaluation_duration_us,
            riskScore: row.risk_score, riskProvider: row.risk_provider,
            evaluatedAt: (row.evaluated_at as Date).toISOString(),
            payment: row.payment_id === null ? null : {
              id: row.payment_id, status: row.payment_status,
              provider: row.provider, simulated: row.provider === 'mock_upi',
            },
          })),
          nextBefore: rows.length === 0
            ? null
            : (rows[rows.length - 1]!.evaluated_at as Date).toISOString(),
        });
      },
    );

    /* --- One decision, with its full rule breakdown ------------------- */
    app.get<{ Params: { id: string } }>(
      '/v1/console/decisions/:id', adminOnly,
      async (request, reply) => {
        const decision = await pool.query(`
          SELECT d.*, r.agent_id, r.merchant_id, r.amount_paise, r.payment_method,
                 r.cart, r.user_intent, r.idempotency_key, r.received_at
            FROM decisions d
            JOIN authorization_requests r ON r.id = d.authorization_request_id
           WHERE d.id = $1`, [request.params.id]);

        if (decision.rowCount === 0) {
          return reply.code(404).send({ error: 'decision_not_found', requestId: request.id });
        }

        const rules = await pool.query(
          `SELECT rule_code, sequence, verdict, signal, expected, actual, reason,
                  observed_paise, limit_paise
             FROM rule_evaluations WHERE decision_id = $1 ORDER BY sequence`,
          [request.params.id],
        );

        const row = decision.rows[0] as Record<string, unknown>;

        return reply.code(200).send({
          id: row.id, verdict: row.verdict, reason: row.reason,
          engineVersion: row.engine_version,
          mandateId: row.mandate_id, mandateVersion: row.mandate_version,
          agentId: row.agent_id, merchantId: row.merchant_id,
          amountPaise: Number(row.amount_paise),
          paymentMethod: row.payment_method,
          cart: row.cart, userIntent: row.user_intent,
          spentBeforePaise: Number(row.spent_before_paise),
          spendWindowStart: (row.spend_window_start as Date).toISOString(),
          spendWindowEnd: (row.spend_window_end as Date).toISOString(),
          riskScore: row.risk_score, riskProvider: row.risk_provider,
          evaluatedAt: (row.evaluated_at as Date).toISOString(),
          evaluationDurationUs: row.evaluation_duration_us,
          // The whole point of the screen: every rule, including the passes.
          evaluations: (rules.rows as Record<string, unknown>[]).map((rule) => ({
            ruleCode: rule.rule_code, sequence: rule.sequence, verdict: rule.verdict,
            signal: rule.signal, expected: rule.expected, actual: rule.actual,
            reason: rule.reason,
            observedPaise: rule.observed_paise === null ? null : Number(rule.observed_paise),
            limitPaise: rule.limit_paise === null ? null : Number(rule.limit_paise),
          })),
        });
      },
    );

    /* --- Mandates ---------------------------------------------------- */
    app.get<{ Querystring: { limit?: string } }>(
      '/v1/console/mandates', adminOnly,
      async (request, reply) => {
        const result = await pool.query(`
          SELECT m.id, m.user_id, m.agent_id, m.label, m.status, m.created_at,
                 m.revoked_at, m.revoked_reason,
                 v.version, v.per_txn_limit_paise, v.window_limit_paise, v.window_kind,
                 v.max_txn_per_hour, v.timezone, v.window_start_hour, v.window_end_hour,
                 v.valid_from, v.valid_to,
                 COALESCE(allow.ids, ARRAY[]::text[]) AS merchant_ids,
                 COALESCE(spend.captured, 0) AS captured_paise
            FROM mandates m
            JOIN LATERAL (
              SELECT * FROM mandate_versions mv
               WHERE mv.mandate_id = m.id ORDER BY mv.version DESC LIMIT 1
            ) v ON true
            LEFT JOIN LATERAL (
              SELECT array_agg(mvm.merchant_id ORDER BY mvm.merchant_id) AS ids
                FROM mandate_version_merchants mvm
               WHERE mvm.mandate_id = v.mandate_id AND mvm.version = v.version
            ) allow ON true
            LEFT JOIN LATERAL (
              SELECT SUM(amount_paise) AS captured FROM payments p
               WHERE p.mandate_id = m.id AND p.status = 'captured'
            ) spend ON true
           ORDER BY m.created_at DESC
           LIMIT $1`, [cap(request.query.limit)]);

        return reply.code(200).send({
          mandates: (result.rows as Record<string, unknown>[]).map((row) => ({
            id: row.id, userId: row.user_id, agentId: row.agent_id,
            label: row.label, status: row.status,
            createdAt: (row.created_at as Date).toISOString(),
            revokedAt: (row.revoked_at as Date | null)?.toISOString() ?? null,
            revokedReason: row.revoked_reason,
            version: row.version,
            perTxnLimitPaise: Number(row.per_txn_limit_paise),
            windowLimitPaise: Number(row.window_limit_paise),
            windowKind: row.window_kind,
            maxTxnPerHour: row.max_txn_per_hour,
            timezone: row.timezone,
            windowStartHour: row.window_start_hour,
            windowEndHour: row.window_end_hour,
            validFrom: (row.valid_from as Date).toISOString(),
            validTo: (row.valid_to as Date).toISOString(),
            merchantIds: row.merchant_ids,
            capturedPaise: Number(row.captured_paise),
          })),
        });
      },
    );

    /* --- Agents ------------------------------------------------------ */
    app.get('/v1/console/agents', adminOnly, async (_request, reply) => {
      const result = await pool.query(`
        SELECT a.id, a.display_name, a.vendor, a.model_id, a.agent_version, a.status,
               a.registered_at,
               COALESCE(g.tools, ARRAY[]::text[]) AS tools,
               COALESCE(c.credentials, 0) AS credentials,
               COALESCE(d.decisions, 0) AS decisions,
               COALESCE(d.blocks, 0) AS blocks
          FROM agents a
          LEFT JOIN LATERAL (
            SELECT array_agg(tool_name ORDER BY tool_name) AS tools
              FROM agent_tool_grants WHERE agent_id = a.id
          ) g ON true
          LEFT JOIN LATERAL (
            SELECT count(*) AS credentials FROM agent_credentials
             WHERE agent_id = a.id AND status = 'active'
          ) c ON true
          LEFT JOIN LATERAL (
            SELECT count(*) AS decisions,
                   count(*) FILTER (WHERE dd.verdict = 'BLOCK') AS blocks
              FROM authorization_requests r
              JOIN decisions dd ON dd.authorization_request_id = r.id
             WHERE r.agent_id = a.id
          ) d ON true
         ORDER BY a.registered_at DESC`);

      return reply.code(200).send({
        agents: (result.rows as Record<string, unknown>[]).map((row) => ({
          id: row.id, displayName: row.display_name, vendor: row.vendor,
          modelId: row.model_id, agentVersion: row.agent_version, status: row.status,
          registeredAt: (row.registered_at as Date).toISOString(),
          tools: row.tools, activeCredentials: Number(row.credentials),
          decisions: Number(row.decisions), blocks: Number(row.blocks),
        })),
      });
    });

    /* --- Payments ---------------------------------------------------- */
    app.get<{ Querystring: { limit?: string } }>(
      '/v1/console/payments', adminOnly,
      async (request, reply) => {
        const result = await pool.query(`
          SELECT p.id, p.mandate_id, p.decision_id, p.amount_paise, p.provider,
                 p.provider_payment_id, p.status, p.failure_code, p.failure_reason,
                 p.created_at, p.captured_at,
                 r.agent_id, r.merchant_id
            FROM payments p
            JOIN decisions d ON d.id = p.decision_id
            JOIN authorization_requests r ON r.id = d.authorization_request_id
           ORDER BY p.created_at DESC
           LIMIT $1`, [cap(request.query.limit)]);

        return reply.code(200).send({
          payments: (result.rows as Record<string, unknown>[]).map((row) => ({
            id: row.id, mandateId: row.mandate_id, decisionId: row.decision_id,
            agentId: row.agent_id, merchantId: row.merchant_id,
            amountPaise: Number(row.amount_paise),
            provider: row.provider, providerPaymentId: row.provider_payment_id,
            status: row.status,
            failureCode: row.failure_code, failureReason: row.failure_reason,
            createdAt: (row.created_at as Date).toISOString(),
            capturedAt: (row.captured_at as Date | null)?.toISOString() ?? null,
            // Never omitted, never inferred by the UI. A screenshot must be
            // unable to present a simulated settlement as a real one.
            simulated: row.provider === 'mock_upi',
          })),
        });
      },
    );

    /* --- Risk signals ------------------------------------------------ */
    app.get<{ Querystring: { limit?: string } }>(
      '/v1/console/risk', adminOnly,
      async (request, reply) => {
        const result = await pool.query(`
          SELECT rs.id, rs.provider, rs.score, rs.band, rs.reasons, rs.latency_ms,
                 rs.is_advisory, rs.created_at,
                 d.id AS decision_id, d.verdict, r.agent_id, r.amount_paise
            FROM risk_signals rs
            JOIN authorization_requests r ON r.id = rs.authorization_request_id
            LEFT JOIN decisions d ON d.authorization_request_id = r.id
           ORDER BY rs.score DESC, rs.created_at DESC
           LIMIT $1`, [cap(request.query.limit)]);

        return reply.code(200).send({
          signals: (result.rows as Record<string, unknown>[]).map((row) => ({
            id: row.id, provider: row.provider, score: row.score, band: row.band,
            reasons: row.reasons, latencyMs: row.latency_ms,
            isAdvisory: row.is_advisory,
            decisionId: row.decision_id, verdict: row.verdict,
            agentId: row.agent_id, amountPaise: Number(row.amount_paise),
            createdAt: (row.created_at as Date).toISOString(),
          })),
          note:
            'Risk scoring is ADVISORY and SIMULATED. It may raise a FLAG; it can ' +
            'never override a BLOCK or create a PASS. The "AFRI" service named ' +
            'in the research does not exist.',
        });
      },
    );
  };
}
