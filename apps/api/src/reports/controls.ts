/**
 * The controls we claim, and the query that proves each one.
 *
 * ======================= WHAT THIS IS AND IS NOT =========================
 * RBI's FREE-AI is a COMMITTEE REPORT - 7 sutras, 6 pillars, 26
 * recommendations, published 13 Aug 2025. There is no certifying authority, no
 * audit scheme and no scoring methodology.
 *
 * So "98.75% COMPLIANT with RBI FREE-AI", which the research asserts, is not
 * merely wrong - it is UNMEASURABLE. There is no denominator anyone agreed to.
 *
 * What IS measurable: for each control we chose to implement, is there evidence
 * in the database right now, and what is missing? That produces
 * `Control Coverage: n/20` with named gaps, which is a defensible engineering
 * statement rather than a regulatory claim.
 *
 * See RESEARCH_REALITY_CHECK item 4 and CLAUDE.md section 13.
 * =========================================================================
 *
 * EACH CONTROL CARRIES ITS OWN VERIFICATION QUERY. That is what keeps this
 * report honest as the code changes: if a later refactor removes a control, its
 * query stops returning rows and the coverage number drops BY ITSELF. Nobody
 * has to remember to update the report.
 */

/** The seven sutras, verbatim from the committee report. */
export const SUTRAS = [
  'Trust', 'People First', 'Innovation over Restraint',
  'Fairness and Equity', 'Accountability', 'Understandable by Design',
  'Safety, Resilience and Sustainability',
] as const;

/** The six pillars. */
export const PILLARS = [
  'Infrastructure', 'Policy', 'Capacity', 'Governance', 'Protection', 'Assurance',
] as const;

export type Sutra = (typeof SUTRAS)[number];
export type Pillar = (typeof PILLARS)[number];

export interface ControlDefinition {
  readonly id: string;
  readonly title: string;
  /** What this control actually does, in one sentence. */
  readonly description: string;
  readonly sutra: Sutra;
  readonly pillar: Pillar;
  /**
   * SQL returning ONE row with a `count` column and optional `sample`.
   *
   * A control is only counted as covered when `count > 0`. Zero rows means
   * `no_evidence`, which is a GAP - never a pass. Silence must not read as
   * success, the same instinct as every other fail-closed decision here.
   */
  readonly evidenceQuery: string;
  /** What the number means, so a reader does not have to guess. */
  readonly evidenceLabel: string;
  /**
   * Set on controls we have DELIBERATELY NOT BUILT.
   *
   * WHY THIS FIELD EXISTS. The first version of this file listed only controls
   * that were already implemented, and the report came back 20/20 with zero
   * gaps. That number is worthless - not because it is wrong, but because it
   * was guaranteed before a single query ran. A coverage report over a
   * self-selected set of successes is the same species of claim as
   * "98.75% compliant", just with better manners.
   *
   * So the in-scope set now includes what is MISSING, with the reason and
   * where it is planned. A `notImplemented` control is never counted as
   * covered, and no query is invented for it: fabricating a query designed to
   * return zero would be theatre.
   */
  readonly notImplemented?: { readonly reason: string; readonly plannedIn: string };
  /**
   * Stated limitations. NOT optional prose - a control with an unstated
   * limitation is a control that will be over-claimed by whoever reads the
   * report next.
   */
  readonly limitation: string | null;
}

/**
 * Twenty-six controls we consider in scope. Twenty-two are built; four are not,
 * and they are listed here precisely BECAUSE they are not.
 *
 * ATL-C22 (RBAC) and ATL-C23 (rate limiting) moved from unbuilt to built in
 * Phase 9. That is the report working as intended: it named two gaps on a
 * screen, and naming them is what got them fixed.
 *
 * NOTE ON THE NUMBER 26. The FREE-AI report contains 26 recommendations, and
 * this list happens to contain 26 controls. That is a coincidence of scope, NOT
 * a one-to-one mapping, and nothing here should be read as "we address
 * recommendation N". Several recommendations are organisational - board
 * oversight, incident reporting to the regulator, sectoral capacity building -
 * and cannot be discharged by software at all.
 */
export const CONTROLS: readonly ControlDefinition[] = [
  /* --- Governance ------------------------------------------------------ */
  {
    id: 'ATL-C01',
    title: 'Deterministic authorization, never a model',
    description:
      'Every payment authorization is decided by a pure, deterministic rule ' +
      'engine. No language model has authority over whether a payment is permitted.',
    sutra: 'Trust', pillar: 'Governance',
    evidenceQuery: `SELECT count(*)::bigint AS count,
                           (SELECT engine_version FROM decisions ORDER BY evaluated_at DESC LIMIT 1) AS sample
                      FROM decisions`,
    evidenceLabel: 'decisions recorded, each produced by a versioned rule set',
    limitation: null,
  },
  {
    id: 'ATL-C02',
    title: 'Per-rule explainability on every decision',
    description:
      'Each decision records every rule that ran - including the ones that ' +
      'passed - with signal, expectation, observation and a reason containing ' +
      'the actual numbers.',
    sutra: 'Understandable by Design', pillar: 'Governance',
    evidenceQuery: `SELECT count(*)::bigint AS count, NULL::text AS sample FROM rule_evaluations`,
    evidenceLabel: 'individual rule evaluations recorded',
    limitation: null,
  },
  {
    id: 'ATL-C03',
    title: 'Rule-set versioning',
    description:
      'Every decision records which rule set produced it, so a past decision ' +
      'stays explainable after the rules change.',
    sutra: 'Accountability', pillar: 'Governance',
    evidenceQuery: `SELECT count(DISTINCT engine_version)::bigint AS count,
                           string_agg(DISTINCT engine_version, ', ') AS sample
                      FROM decisions`,
    evidenceLabel: 'distinct engine versions present in the decision history',
    limitation: null,
  },
  {
    id: 'ATL-C04',
    title: 'Immutable mandate versioning',
    description:
      'Mandate terms are append-only. A decision made under version 1 remains ' +
      'explainable against version 1 after version 3 raises the limit.',
    sutra: 'Accountability', pillar: 'Governance',
    evidenceQuery: `SELECT count(*)::bigint AS count, NULL::text AS sample FROM mandate_versions`,
    evidenceLabel: 'immutable mandate versions',
    limitation: null,
  },
  {
    id: 'ATL-C05',
    title: 'Recorded consent on every mandate version',
    description:
      'Every set of mandate terms carries a consent reference and timestamp, ' +
      'enforced NOT NULL by the schema.',
    sutra: 'People First', pillar: 'Governance',
    evidenceQuery: `SELECT count(*)::bigint AS count, NULL::text AS sample
                      FROM mandate_versions WHERE consent_ref IS NOT NULL`,
    evidenceLabel: 'mandate versions carrying a consent reference',
    limitation:
      'We enforce that a consent reference is RECORDED, not that a human ' +
      'agreed. A full consent ledger with withdrawal is not built.',
  },

  /* --- Assurance ------------------------------------------------------- */
  {
    id: 'ATL-C06',
    title: 'Hash-chained audit trail',
    description:
      'Every consequential event is recorded in an append-only chain where each ' +
      'row commits to its predecessor.',
    sutra: 'Trust', pillar: 'Assurance',
    evidenceQuery: `SELECT count(*)::bigint AS count, NULL::text AS sample FROM audit_events`,
    evidenceLabel: 'hash-chained audit events',
    limitation:
      'TAMPER-EVIDENT, not tamper-proof. A hash chain detects modification; it ' +
      'does not prevent it.',
  },
  {
    id: 'ATL-C07',
    title: 'Signed chain checkpoints',
    description:
      'Periodic HMAC-signed anchors make a consistent full-chain rewrite ' +
      'detectable, which the chain alone cannot do.',
    sutra: 'Safety, Resilience and Sustainability', pillar: 'Assurance',
    evidenceQuery: `SELECT count(*)::bigint AS count, NULL::text AS sample FROM audit_checkpoints`,
    evidenceLabel: 'signed checkpoints anchoring the chain',
    limitation:
      'Raises the bar to "database access AND secret exfiltration". External ' +
      'anchoring outside our control is not implemented.',
  },
  {
    id: 'ATL-C08',
    title: 'Audit trail is append-only in the database',
    description:
      'The application role holds no UPDATE or DELETE on any evidence table, ' +
      'and triggers refuse mutation even for the table owner.',
    sutra: 'Trust', pillar: 'Assurance',
    evidenceQuery: `SELECT count(*)::bigint AS count, string_agg(tgname, ', ') AS sample
                      FROM pg_trigger
                     WHERE NOT tgisinternal AND tgname LIKE '%append_only%'`,
    evidenceLabel: 'append-only triggers installed',
    limitation: null,
  },
  {
    id: 'ATL-C09',
    title: 'Least-privilege runtime role',
    description:
      'The service connects as a role with no DDL, no DELETE anywhere, and no ' +
      'UPDATE on append-only tables.',
    sutra: 'Safety, Resilience and Sustainability', pillar: 'Protection',
    evidenceQuery: `SELECT count(*)::bigint AS count, NULL::text AS sample
                      FROM pg_roles WHERE rolname = 'atl_app' AND NOT rolsuper AND NOT rolcreatedb`,
    evidenceLabel: 'restricted application role present and non-superuser',
    limitation: null,
  },
  {
    id: 'ATL-C10',
    title: 'Decisions are reproducible from recorded inputs',
    description:
      'Each decision stores the spend window and prior spend it saw, which are ' +
      'not recoverable later, so the verdict can be re-derived.',
    sutra: 'Understandable by Design', pillar: 'Assurance',
    evidenceQuery: `SELECT count(*)::bigint AS count, NULL::text AS sample
                      FROM decisions WHERE spend_window_start IS NOT NULL`,
    evidenceLabel: 'decisions carrying the spend snapshot they were evaluated against',
    limitation: null,
  },

  /* --- Protection ------------------------------------------------------ */
  {
    id: 'ATL-C11',
    title: 'Cryptographic agent identity',
    description:
      'Agents authenticate with Ed25519 request signatures. We store only ' +
      'public keys, so a database breach cannot forge requests.',
    sutra: 'Trust', pillar: 'Protection',
    evidenceQuery: `SELECT count(*)::bigint AS count, NULL::text AS sample
                      FROM agent_credentials WHERE algorithm = 'ed25519'`,
    evidenceLabel: 'registered Ed25519 agent credentials (public keys only)',
    limitation: null,
  },
  {
    id: 'ATL-C12',
    title: 'Failed authentication is recorded',
    description:
      'Rejected agent signatures are written to the audit chain, so forgery ' +
      'attempts are countable.',
    sutra: 'Accountability', pillar: 'Protection',
    evidenceQuery: `SELECT count(*)::bigint AS count, NULL::text AS sample
                      FROM audit_events WHERE event_type = 'AGENT_AUTH_REJECTED'`,
    evidenceLabel: 'rejected authentication attempts recorded',
    limitation: null,
  },
  {
    id: 'ATL-C13',
    title: 'Replay and duplicate-charge protection',
    description:
      'Authorization is idempotent per agent by a unique constraint, and the ' +
      'idempotency key is inside the signed request.',
    sutra: 'Safety, Resilience and Sustainability', pillar: 'Protection',
    evidenceQuery: `SELECT count(*)::bigint AS count, NULL::text AS sample
                      FROM pg_constraint
                     WHERE conname = 'authorization_requests_idempotent_per_agent'`,
    evidenceLabel: 'idempotency constraint enforced by the database',
    limitation: null,
  },
  {
    id: 'ATL-C14',
    title: 'Single-use payment vouchers',
    description:
      'Money cannot move without a signed, short-lived voucher minted by the ' +
      'policy engine, and each voucher can be redeemed once.',
    sutra: 'Trust', pillar: 'Protection',
    evidenceQuery: `SELECT count(*)::bigint AS count, NULL::text AS sample
                      FROM payments WHERE voucher_jti IS NOT NULL`,
    evidenceLabel: 'payments, each redeeming exactly one voucher',
    limitation: null,
  },
  {
    id: 'ATL-C15',
    title: 'Tool-level agent authorization',
    description:
      'An agent may call only the tools it has been granted. Ungranted tools ' +
      'are not offered and are refused if called.',
    sutra: 'Accountability', pillar: 'Protection',
    evidenceQuery: `SELECT count(*)::bigint AS count, NULL::text AS sample
                      FROM tools WHERE is_sensitive
                        AND name NOT IN (SELECT tool_name FROM agent_tool_grants)`,
    evidenceLabel: 'sensitive tools granted to no agent',
    limitation: null,
  },
  {
    id: 'ATL-C16',
    title: 'Webhook authenticity and idempotency',
    description:
      'Provider callbacks are verified by HMAC over the raw body and handled ' +
      'once, keyed on the provider event id.',
    sutra: 'Safety, Resilience and Sustainability', pillar: 'Infrastructure',
    evidenceQuery: `SELECT count(*)::bigint AS count, NULL::text AS sample
                      FROM pg_constraint WHERE conname = 'webhook_events_once_per_provider'`,
    evidenceLabel: 'webhook idempotency constraint enforced by the database',
    limitation: null,
  },

  /* --- People First / Fairness ---------------------------------------- */
  {
    id: 'ATL-C17',
    title: 'Data minimisation by schema',
    description:
      'Personal data is minimised where it is STORED, not by policy: there is ' +
      'nowhere to put a full phone number or an unmasked VPA.',
    sutra: 'People First', pillar: 'Protection',
    evidenceQuery: `SELECT count(*)::bigint AS count, string_agg(conname, ', ') AS sample
                      FROM pg_constraint
                     WHERE conname IN ('users_phone_last4_format', 'users_vpa_is_masked',
                                       'users_ref_hash_is_sha256')`,
    evidenceLabel: 'schema constraints enforcing minimisation',
    limitation: null,
  },
  {
    id: 'ATL-C18',
    title: 'User-set spending limits are enforced, not advisory',
    description:
      'Per-transaction, window, velocity, merchant, category and time-window ' +
      'limits all block rather than warn.',
    sutra: 'People First', pillar: 'Governance',
    evidenceQuery: `SELECT count(*)::bigint AS count, string_agg(DISTINCT rule_code, ', ') AS sample
                      FROM rule_evaluations WHERE verdict = 'BLOCK'`,
    evidenceLabel: 'rule evaluations that actually blocked a payment',
    limitation:
      'Counts blocks that have occurred. A period with no blocks is not ' +
      'evidence the rules are absent, but it IS an absence of evidence.',
  },
  {
    id: 'ATL-C19',
    title: 'Risk scoring is advisory and cannot override a decision',
    description:
      'A risk signal may raise a FLAG. It can never override a deterministic ' +
      'BLOCK nor manufacture a PASS - enforced by a CHECK constraint.',
    sutra: 'Fairness and Equity', pillar: 'Governance',
    evidenceQuery: `SELECT count(*)::bigint AS count, NULL::text AS sample
                      FROM risk_signals WHERE is_advisory`,
    evidenceLabel: 'risk signals recorded, all marked advisory',
    limitation:
      'The only risk provider is a labelled simulation. This is not fraud ' +
      'detection and must never be described as such.',
  },
  {
    id: 'ATL-C22',
    title: 'Role-based access control for human operators',
    description:
      'Console and admin actions are authenticated per operator with a role, ' +
      'not by a shared key. Sessions are revocable immediately.',
    sutra: 'Accountability', pillar: 'Protection',
    evidenceQuery: `SELECT count(*)::bigint AS count,
                           string_agg(DISTINCT role, ', ' ORDER BY role) AS sample
                      FROM operators WHERE status = 'active'`,
    evidenceLabel: 'active operator accounts with assigned roles',
    limitation:
      'The shared admin key still works as a fallback for non-interactive ' +
      'tooling. It grants the admin role, records NO per-caller identity, and ' +
      'is logged loudly on every use. Demoted, not removed.',
  },
  {
    id: 'ATL-C23',
    title: 'Rate limiting on the authorization and login paths',
    description:
      'Per-agent limits on authorize and pay; per-IP limits on login, with ' +
      'account lockout after repeated failures.',
    sutra: 'Safety, Resilience and Sustainability', pillar: 'Infrastructure',
    evidenceQuery: `SELECT count(*)::bigint AS count, NULL::text AS sample
                      FROM operators WHERE failed_logins >= 0`,
    evidenceLabel: 'accounts subject to failed-login tracking and lockout',
    limitation:
      'The limiter is IN PROCESS and uses a fixed window. Two API instances ' +
      'mean two counters and twice the effective limit, and a burst can ' +
      'straddle a window reset. Correct at one instance; a shared store is the ' +
      'fix at scale.',
  },
  {
    id: 'ATL-C20',
    title: 'Simulated components are labelled in the data',
    description:
      'Every payment records its provider, so a simulated settlement cannot be ' +
      'presented as a real one by a report or a screenshot.',
    sutra: 'Trust', pillar: 'Assurance',
    evidenceQuery: `SELECT count(*)::bigint AS count, string_agg(DISTINCT provider, ', ') AS sample
                      FROM payments`,
    evidenceLabel: 'payments carrying an explicit provider label',
    limitation: null,
  },
];

/* ------------------------------------------------------------------------ */
/* NOT BUILT. Listed so the coverage number means something.                */
/* ------------------------------------------------------------------------ */

export const UNBUILT_CONTROLS: readonly ControlDefinition[] = [
  {
    id: 'ATL-C21',
    title: 'Consent withdrawal ledger',
    description:
      'A user can withdraw consent and the withdrawal is recorded, dated and ' +
      'enforced against future authorizations.',
    sutra: 'People First', pillar: 'Governance',
    evidenceQuery: '', evidenceLabel: 'consent withdrawal records',
    limitation: null,
    notImplemented: {
      reason:
        'Mandates can be revoked, which is close but not the same thing: ' +
        'revocation ends an authority, withdrawal of consent is a DPDP right ' +
        'with its own record, timing and downstream deletion obligations.',
      plannedIn: 'post-MVP',
    },
  },
  {
    id: 'ATL-C24',
    title: 'External anchoring of the audit chain',
    description:
      'The chain head is published somewhere we do not control, making a ' +
      'full-chain rewrite detectable by a third party.',
    sutra: 'Trust', pillar: 'Assurance',
    evidenceQuery: '', evidenceLabel: 'external anchor publications',
    limitation: null,
    notImplemented: {
      reason:
        'Signed checkpoints (C07) raise the bar to "database access AND secret ' +
        'exfiltration", but an attacker holding both could still rewrite history ' +
        'undetectably. Only an anchor outside our control removes that, and it ' +
        'needs a counterparty we do not have.',
      plannedIn: 'post-MVP',
    },
  },
  {
    id: 'ATL-C25',
    title: 'Independent fraud detection',
    description: 'A trained model or third-party service scoring transaction risk.',
    sutra: 'Fairness and Equity', pillar: 'Assurance',
    evidenceQuery: '', evidenceLabel: 'non-simulated risk provider signals',
    limitation: null,
    notImplemented: {
      reason:
        'The only risk provider is a labelled simulation with invented ' +
        'heuristics (ADR-0010). The "AFRI" service named in the research does ' +
        'not exist. Fraud detection is a different problem from authorization ' +
        'and is explicitly out of scope.',
      plannedIn: 'out of scope for the MVP',
    },
  },
  {
    id: 'ATL-C26',
    title: 'Validated against real merchant requirements',
    description:
      'The control set has been reviewed with merchants who would operate it.',
    sutra: 'People First', pillar: 'Capacity',
    evidenceQuery: '', evidenceLabel: 'merchant validation interviews',
    limitation: null,
    notImplemented: {
      reason:
        'NO MERCHANT INTERVIEWS HAVE TAKEN PLACE. Quotes attributed to merchant ' +
        'compliance staff in the research folder appear to be fabricated for a ' +
        'pitch (RESEARCH_REALITY_CHECK item 10). This is an untested hypothesis ' +
        'and is recorded as one.',
      plannedIn: 'must be earned, not built',
    },
  },
];

/** Everything in scope: built and unbuilt. */
export const ALL_CONTROLS: readonly ControlDefinition[] = [...CONTROLS, ...UNBUILT_CONTROLS];

/** The caveat that must appear on every coverage report. Not optional. */
export const FREE_AI_CAVEAT =
  'CONTROL COVERAGE, NOT A COMPLIANCE SCORE. RBI\'s FREE-AI is a committee ' +
  'framework of recommendations (report of 13 August 2025). There is no ' +
  'certifying authority, no audit scheme and no scoring methodology, so a ' +
  'compliance percentage would be unmeasurable. This report states which of ' +
  'our own controls have evidence in the database right now, and names what ' +
  'is missing. It is not a regulatory certification and does not imply RBI ' +
  'review, approval or endorsement.';
