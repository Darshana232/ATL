-- ===========================================================================
-- 0004_authorization.sql - requests, decisions, rule evaluations,
--                          risk signals, payments
--
-- The record of what an agent asked for, what the deterministic engine
-- decided, why, and what happened to the money.
--
-- Everything here except `payments` is APPEND-ONLY: a request is a historical
-- fact and a decision is a historical fact. `payments` has a genuine lifecycle
-- (created -> authorized -> captured), so it is mutable but its transitions
-- are constrained by a trigger.
--
-- IMMUTABLE ONCE APPLIED.
-- ===========================================================================


-- ---------------------------------------------------------------------------
-- authorization_requests - what the agent asked for. APPEND-ONLY.
--
-- Recorded BEFORE any decision is made, so a request that crashes the engine
-- still leaves a trace. "We have no record of that request" is the worst
-- possible answer to an auditor.
-- ---------------------------------------------------------------------------
CREATE TABLE authorization_requests (
  id                    TEXT        PRIMARY KEY,

  -- The mandate AND the exact version in force when we evaluated. Pinning the
  -- version here means a later mandate change cannot retroactively alter what
  -- this request was judged against.
  mandate_id            TEXT        NOT NULL,
  mandate_version       INTEGER     NOT NULL,

  -- Who actually called, established by signature verification - not by what
  -- the request body claimed. The engine separately checks that this agent is
  -- the one the mandate was granted to.
  agent_id              TEXT        NOT NULL REFERENCES agents (id) ON DELETE RESTRICT,
  credential_id         TEXT        REFERENCES agent_credentials (id) ON DELETE RESTRICT,

  -- Recorded even when false: a rejected-signature attempt is exactly the kind
  -- of event a security review wants to count.
  signature_verified    BOOLEAN     NOT NULL,

  merchant_id           TEXT        NOT NULL REFERENCES merchants (id) ON DELETE RESTRICT,

  amount_paise          BIGINT      NOT NULL,
  currency              TEXT        NOT NULL DEFAULT 'INR',
  payment_method        TEXT        NOT NULL,

  -- Idempotency. The UNIQUE constraint below is what actually prevents a
  -- network retry from becoming a second charge - not application logic.
  idempotency_key       TEXT        NOT NULL,

  -- The HTTP request id, so this row joins to the application logs for the
  -- same request. Observability and evidence, linked.
  request_id            TEXT        NOT NULL,

  -- The cart. JSONB is correct HERE because no RULE reads it: category
  -- checking keys off the merchant's MCC, not off item names. Per our rule -
  -- anything a rule reads is a column, anything only a human reads may be
  -- JSONB.
  cart                  JSONB,

  -- The user's natural-language instruction, kept for explainability
  -- ("why did the agent buy this?").
  --
  -- DPDP: this is personal data. It is recorded in the Phase 10 processing
  -- register with an explicit purpose (dispute resolution and explainability)
  -- rather than collected by default and justified later.
  user_intent           TEXT,

  received_at           TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT authorization_requests_id_format
    CHECK (id ~ '^authz_[a-z0-9_]{2,40}$'),

  -- Composite FK: the request points at terms that must exist.
  CONSTRAINT authorization_requests_mandate_version_fk
    FOREIGN KEY (mandate_id, mandate_version)
    REFERENCES mandate_versions (mandate_id, version) ON DELETE RESTRICT,

  CONSTRAINT authorization_requests_amount_positive
    CHECK (amount_paise > 0),

  -- INR only, stated rather than assumed. A multi-currency audit record would
  -- need a rate and a rate timestamp to be meaningful, and we have neither.
  CONSTRAINT authorization_requests_currency_inr
    CHECK (currency = 'INR'),

  CONSTRAINT authorization_requests_payment_method_valid
    CHECK (payment_method IN ('upi_reserve_pay', 'upi_autopay', 'card', 'netbanking')),

  CONSTRAINT authorization_requests_idempotency_key_shape
    CHECK (length(idempotency_key) BETWEEN 8 AND 255),

  -- Idempotency is scoped PER AGENT: two agents may legitimately choose the
  -- same key, and one agent must never be able to squat another's key space.
  CONSTRAINT authorization_requests_idempotent_per_agent
    UNIQUE (agent_id, idempotency_key)
);

CREATE TRIGGER authorization_requests_append_only
  BEFORE UPDATE OR DELETE ON authorization_requests
  FOR EACH ROW EXECUTE FUNCTION reject_mutation();

CREATE TRIGGER authorization_requests_no_truncate
  BEFORE TRUNCATE ON authorization_requests
  FOR EACH STATEMENT EXECUTE FUNCTION reject_truncate();

-- Dashboard: "this mandate's activity, newest first".
CREATE INDEX authorization_requests_by_mandate_idx
  ON authorization_requests (mandate_id, received_at DESC);

-- Security review: "everything this agent attempted".
CREATE INDEX authorization_requests_by_agent_idx
  ON authorization_requests (agent_id, received_at DESC);

-- Investigation: failed signature attempts. Partial, because they should be
-- rare - a small index over the interesting rows.
CREATE INDEX authorization_requests_bad_signature_idx
  ON authorization_requests (agent_id, received_at DESC)
  WHERE signature_verified = false;

COMMENT ON TABLE authorization_requests IS
  'What an agent asked for. Append-only, written before evaluation so a '
  'request that crashes the engine still leaves a trace.';


-- ---------------------------------------------------------------------------
-- decisions - the verdict. APPEND-ONLY. One per request.
--
-- WHAT THIS TABLE DOES AND DOES NOT COPY, and why they differ:
--
--   Mandate terms       -> NOT copied. Recoverable forever through the
--                          composite FK to the immutable version row, so a
--                          copy would be duplication, and duplicated data
--                          diverges.
--
--   spent_before_paise  -> COPIED. NOT recoverable later: refunds, subsequent
--                          payments and the passage of time all change what
--                          "spent in the window" evaluates to. If we did not
--                          record it, we could never re-derive why this
--                          decision saw the headroom it saw.
--
-- The rule: reference what you can reconstruct, store what you cannot.
-- ---------------------------------------------------------------------------
CREATE TABLE decisions (
  id                        TEXT        PRIMARY KEY,

  -- UNIQUE: exactly one decision per request. A second decision for the same
  -- request would make "what did we decide?" ambiguous.
  authorization_request_id  TEXT        NOT NULL UNIQUE
                                        REFERENCES authorization_requests (id) ON DELETE RESTRICT,

  -- Denormalised from the request so decision queries and reports do not need
  -- a join. Safe because both are immutable and FK-enforced.
  mandate_id                TEXT        NOT NULL,
  mandate_version           INTEGER     NOT NULL,

  verdict                   TEXT        NOT NULL,

  -- The human-readable summary, GENERATED BY CODE from the rule that failed -
  -- never prose produced by a model. It must contain the numbers:
  -- "Requested ₹6,200 exceeds the ₹2,000 per-transaction limit by ₹4,200."
  reason                    TEXT        NOT NULL,

  -- Which rule-set produced this verdict. Without it, "why was this allowed
  -- in September?" is unanswerable after the rules change - and the rules WILL
  -- change as regulatory guidance clarifies.
  engine_version            TEXT        NOT NULL,

  -- The spend window actually used, and the total already spent in it.
  spend_window_start        TIMESTAMPTZ NOT NULL,
  spend_window_end          TIMESTAMPTZ NOT NULL,
  spent_before_paise        BIGINT      NOT NULL,

  -- Advisory risk input, if a provider answered. NULL means "no signal", which
  -- is different from "score 0" and must stay distinguishable.
  risk_score                SMALLINT,
  risk_provider             TEXT,

  evaluated_at              TIMESTAMPTZ NOT NULL DEFAULT now(),

  -- Microseconds: rule evaluation should be well under a millisecond, and
  -- integer milliseconds would round most of it to 0.
  evaluation_duration_us    INTEGER,

  CONSTRAINT decisions_id_format
    CHECK (id ~ '^dec_[a-z0-9_]{2,40}$'),

  CONSTRAINT decisions_mandate_version_fk
    FOREIGN KEY (mandate_id, mandate_version)
    REFERENCES mandate_versions (mandate_id, version) ON DELETE RESTRICT,

  -- Three verdicts, no more. FLAG means "allowed, but recorded as suspicious
  -- for human review" - the STR candidate path.
  CONSTRAINT decisions_verdict_valid
    CHECK (verdict IN ('PASS', 'FLAG', 'BLOCK')),

  CONSTRAINT decisions_reason_not_blank
    CHECK (length(trim(reason)) > 0),

  CONSTRAINT decisions_engine_version_not_blank
    CHECK (length(trim(engine_version)) > 0),

  CONSTRAINT decisions_spend_window_ordered
    CHECK (spend_window_end > spend_window_start),

  CONSTRAINT decisions_spent_before_non_negative
    CHECK (spent_before_paise >= 0),

  CONSTRAINT decisions_risk_score_range
    CHECK (risk_score IS NULL OR risk_score BETWEEN 0 AND 100),

  -- A score without its provider cannot be interpreted or re-checked.
  CONSTRAINT decisions_risk_complete
    CHECK ((risk_score IS NULL) = (risk_provider IS NULL)),

  CONSTRAINT decisions_duration_non_negative
    CHECK (evaluation_duration_us IS NULL OR evaluation_duration_us >= 0)
);

CREATE TRIGGER decisions_append_only
  BEFORE UPDATE OR DELETE ON decisions
  FOR EACH ROW EXECUTE FUNCTION reject_mutation();

CREATE TRIGGER decisions_no_truncate
  BEFORE TRUNCATE ON decisions
  FOR EACH STATEMENT EXECUTE FUNCTION reject_truncate();

CREATE INDEX decisions_by_mandate_idx ON decisions (mandate_id, evaluated_at DESC);

-- Reporting: "every block and flag this month". Partial, because PASS is the
-- overwhelming majority and reports care about the exceptions.
CREATE INDEX decisions_exceptions_idx
  ON decisions (evaluated_at DESC)
  WHERE verdict IN ('BLOCK', 'FLAG');

COMMENT ON TABLE decisions IS
  'Deterministic verdict for one authorization request. Append-only. '
  'References mandate terms (recoverable) and stores window spend (not).';


-- ---------------------------------------------------------------------------
-- rule_evaluations - one row per rule per decision. APPEND-ONLY.
--
-- This table IS the explainability feature. A decision without its per-rule
-- breakdown is an assertion; with it, a merchant, a user and a compliance
-- officer can each read exactly which check failed and by how much.
--
-- Every rule that runs gets a row, INCLUDING the ones that passed. Recording
-- only failures would leave us unable to prove a check was performed at all -
-- and "we did check that" is precisely what an auditor asks.
-- ---------------------------------------------------------------------------
CREATE TABLE rule_evaluations (
  decision_id     TEXT        NOT NULL REFERENCES decisions (id) ON DELETE RESTRICT,

  -- Stable machine identifier, e.g. MANDATE_PER_TXN_LIMIT. Reports group by
  -- it, so it is a column and never free text in a blob.
  rule_code       TEXT        NOT NULL,

  -- Execution order, so the trail can be replayed exactly as it ran.
  sequence        SMALLINT    NOT NULL,

  verdict         TEXT        NOT NULL,

  -- The Signal -> Rule -> Evaluation -> Verdict -> Reason chain, as data.
  signal          TEXT        NOT NULL,   -- what was observed
  expected        TEXT        NOT NULL,   -- what the mandate permitted
  actual          TEXT        NOT NULL,   -- what the request contained
  reason          TEXT        NOT NULL,   -- one sentence, with numbers

  -- Machine-readable versions for money rules, so a report can compute
  -- "breached by ₹4,200" without parsing English out of `reason`.
  -- NULL for non-monetary rules (expiry, revocation, merchant allowlist).
  observed_paise  BIGINT,
  limit_paise     BIGINT,

  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),

  -- A rule evaluates exactly once per decision.
  PRIMARY KEY (decision_id, rule_code),

  CONSTRAINT rule_evaluations_rule_code_format
    CHECK (rule_code ~ '^[A-Z][A-Z0-9_]{2,60}$'),

  -- SKIP is a real outcome and must be recorded: a velocity rule cannot run
  -- if the mandate sets no velocity limit, and silence would be
  -- indistinguishable from a pass.
  CONSTRAINT rule_evaluations_verdict_valid
    CHECK (verdict IN ('PASS', 'FLAG', 'BLOCK', 'SKIP')),

  CONSTRAINT rule_evaluations_sequence_positive
    CHECK (sequence >= 1),

  CONSTRAINT rule_evaluations_text_not_blank
    CHECK (
      length(trim(signal)) > 0 AND length(trim(expected)) > 0
      AND length(trim(actual)) > 0 AND length(trim(reason)) > 0
    ),

  CONSTRAINT rule_evaluations_amounts_non_negative
    CHECK (
      (observed_paise IS NULL OR observed_paise >= 0)
      AND (limit_paise IS NULL OR limit_paise >= 0)
    )
);

CREATE TRIGGER rule_evaluations_append_only
  BEFORE UPDATE OR DELETE ON rule_evaluations
  FOR EACH ROW EXECUTE FUNCTION reject_mutation();

CREATE TRIGGER rule_evaluations_no_truncate
  BEFORE TRUNCATE ON rule_evaluations
  FOR EACH STATEMENT EXECUTE FUNCTION reject_truncate();

-- Reporting: "all per-transaction-cap breaches this month", which is the
-- FREE-AI coverage report and the STR candidate query.
CREATE INDEX rule_evaluations_by_rule_verdict_idx
  ON rule_evaluations (rule_code, verdict, created_at DESC);

COMMENT ON TABLE rule_evaluations IS
  'Per-rule breakdown behind each decision, including passes. Append-only. '
  'This table is the explainability feature.';


-- ---------------------------------------------------------------------------
-- risk_signals - advisory input. APPEND-ONLY.
--
-- Fraud detection ("was this suspicious?") is a DIFFERENT PROBLEM from
-- authorization ("was this permitted?"). Authorization must be deterministic
-- and explainable; risk scoring is probabilistic and empirical. Merging them
-- would make our verdicts unexplainable and our fraud detection untestable.
--
-- So a risk signal can raise a FLAG, but it can NEVER override a deterministic
-- BLOCK nor manufacture a PASS. The is_advisory column below enforces that
-- intent in the schema: changing it requires a migration and therefore a
-- review, rather than one line in a service.
--
-- MVP: the only provider is 'mock'. The "AFRI" service referenced in the
-- research does not exist - it is a proposal document (ADR-0010).
-- ---------------------------------------------------------------------------
CREATE TABLE risk_signals (
  id                        TEXT        PRIMARY KEY,

  authorization_request_id  TEXT        NOT NULL
                                        REFERENCES authorization_requests (id) ON DELETE RESTRICT,

  provider                  TEXT        NOT NULL,
  score                     SMALLINT    NOT NULL,
  band                      TEXT        NOT NULL,

  -- Why the provider said what it said. Array rather than JSONB because the
  -- dashboard lists them and reports count them.
  reasons                   TEXT[]      NOT NULL DEFAULT '{}',

  -- Latency matters: a risk provider is on the authorization path, so a slow
  -- one degrades every payment. Recorded so we can prove it, and so a future
  -- timeout budget is based on data.
  latency_ms                INTEGER,

  is_advisory               BOOLEAN     NOT NULL DEFAULT true,

  created_at                TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT risk_signals_id_format
    CHECK (id ~ '^rsk_[a-z0-9_]{2,40}$'),

  CONSTRAINT risk_signals_provider_valid
    CHECK (provider IN ('mock', 'afri')),

  CONSTRAINT risk_signals_score_range
    CHECK (score BETWEEN 0 AND 100),

  CONSTRAINT risk_signals_band_valid
    CHECK (band IN ('LOW', 'MEDIUM', 'HIGH')),

  -- Documentation as a constraint: risk is advisory, always. Making this
  -- authoritative would require a migration and a code review, which is
  -- exactly the friction such a change deserves.
  CONSTRAINT risk_signals_always_advisory
    CHECK (is_advisory),

  CONSTRAINT risk_signals_latency_non_negative
    CHECK (latency_ms IS NULL OR latency_ms >= 0)
);

CREATE TRIGGER risk_signals_append_only
  BEFORE UPDATE OR DELETE ON risk_signals
  FOR EACH ROW EXECUTE FUNCTION reject_mutation();

CREATE TRIGGER risk_signals_no_truncate
  BEFORE TRUNCATE ON risk_signals
  FOR EACH STATEMENT EXECUTE FUNCTION reject_truncate();

CREATE INDEX risk_signals_by_request_idx ON risk_signals (authorization_request_id);

COMMENT ON TABLE risk_signals IS
  'Advisory risk score for a request. Can raise a FLAG; can never override a '
  'BLOCK or create a PASS.';


-- ---------------------------------------------------------------------------
-- payments - the money. MUTABLE, but only along a legal path.
--
-- THE MOST IMPORTANT COLUMN HERE IS voucher_jti, AND IT IS UNIQUE.
--
-- On PASS the policy engine mints a single-use, short-lived, signed voucher.
-- The payment service refuses to capture without one. The UNIQUE constraint is
-- what makes "single-use" a fact rather than a promise: replaying a voucher
-- fails at INSERT, and two perfectly concurrent captures can still only
-- produce one row.
--
-- Enforcement belongs where it cannot be bypassed. Application-level
-- "have we seen this jti?" logic loses that race; a unique index does not.
-- ---------------------------------------------------------------------------
CREATE TABLE payments (
  id                    TEXT        PRIMARY KEY,

  -- One payment per decision. A second would mean a single authorization
  -- moved money twice.
  decision_id           TEXT        NOT NULL UNIQUE
                                    REFERENCES decisions (id) ON DELETE RESTRICT,

  -- Denormalised from the decision, deliberately, against the usual
  -- no-duplication instinct. Justified on three conditions:
  --   1. hot path - the velocity/spend query runs on EVERY authorization and
  --      would otherwise need two joins to reach the mandate
  --   2. immutable - a payment's mandate never changes
  --   3. FK-enforced - it cannot be wrong
  -- Denormalise when all three hold; not otherwise.
  mandate_id            TEXT        NOT NULL REFERENCES mandates (id) ON DELETE RESTRICT,

  -- The single-use capability token id. UNIQUE = replay protection in the
  -- database.
  voucher_jti           TEXT        NOT NULL UNIQUE,

  amount_paise          BIGINT      NOT NULL,

  provider              TEXT        NOT NULL,
  provider_order_id     TEXT,
  provider_payment_id   TEXT,

  status                TEXT        NOT NULL DEFAULT 'created',

  failure_code          TEXT,
  failure_reason        TEXT,

  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  authorized_at         TIMESTAMPTZ,
  captured_at           TIMESTAMPTZ,
  failed_at             TIMESTAMPTZ,
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT payments_id_format
    CHECK (id ~ '^pay_[a-z0-9_]{2,40}$'),

  CONSTRAINT payments_amount_positive
    CHECK (amount_paise > 0),

  -- Honest labelling in the schema: 'mock_upi' is a simulation, and the column
  -- says so on every row. A report cannot accidentally present simulated
  -- settlements as real ones.
  CONSTRAINT payments_provider_valid
    CHECK (provider IN ('mock_upi', 'razorpay_test')),

  CONSTRAINT payments_status_valid
    CHECK (status IN ('created', 'authorized', 'captured', 'failed', 'refunded')),

  -- Each state must carry its timestamp. A row claiming to be captured with no
  -- captured_at cannot be reconciled against a settlement report.
  CONSTRAINT payments_captured_timestamped
    CHECK (status <> 'captured' OR captured_at IS NOT NULL),
  CONSTRAINT payments_failed_timestamped
    CHECK (status <> 'failed' OR failed_at IS NOT NULL),

  -- A failure must say why. "It failed" is not a reconcilable record.
  CONSTRAINT payments_failure_explained
    CHECK (status <> 'failed' OR (failure_code IS NOT NULL AND failure_reason IS NOT NULL)),

  CONSTRAINT payments_voucher_jti_shape
    CHECK (length(voucher_jti) BETWEEN 16 AND 128)
);

CREATE TRIGGER payments_set_updated_at
  BEFORE UPDATE ON payments
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ---------------------------------------------------------------------------
-- Payment state machine, enforced in the database.
--
--   created ──► authorized ──► captured ──► refunded
--      │             │
--      └─────────────┴──────► failed        (both terminal)
--
-- Why here and not only in code: a payment that goes captured -> created is
-- not merely a bug, it is a record that lies about whether money moved. The
-- application should prevent it; the database must.
-- ---------------------------------------------------------------------------
CREATE FUNCTION payments_guard_transition() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  allowed TEXT[];
BEGIN
  -- IMMUTABILITY IS CHECKED FIRST, AND THE ORDER IS THE POINT.
  --
  -- The amount and the voucher identify what was authorised. Changing either
  -- after the fact would let a captured payment claim a different
  -- authorisation than the one that permitted it.
  --
  -- An earlier version of this trigger returned early when the status was
  -- unchanged, and put this check afterwards - which made it UNREACHABLE in
  -- precisely the case it exists for, since a quiet amount edit does not
  -- change the status. Guard ordering is a correctness property: an early
  -- return can silently disable every check below it. Caught by a test.
  IF NEW.amount_paise <> OLD.amount_paise OR NEW.voucher_jti <> OLD.voucher_jti THEN
    RAISE EXCEPTION 'payment amount and voucher are immutable after creation'
      USING ERRCODE = 'ATL02';
  END IF;

  IF NEW.status = OLD.status THEN
    RETURN NEW;  -- no transition; other columns may still be updated
  END IF;

  allowed := CASE OLD.status
    WHEN 'created'    THEN ARRAY['authorized', 'failed']
    WHEN 'authorized' THEN ARRAY['captured', 'failed']
    WHEN 'captured'   THEN ARRAY['refunded']
    WHEN 'failed'     THEN ARRAY[]::TEXT[]     -- terminal
    WHEN 'refunded'   THEN ARRAY[]::TEXT[]     -- terminal
    ELSE ARRAY[]::TEXT[]
  END;

  IF NOT (NEW.status = ANY (allowed)) THEN
    RAISE EXCEPTION 'illegal payment transition: % -> %', OLD.status, NEW.status
      USING ERRCODE = 'ATL02',
            HINT = 'Legal: created->authorized|failed, authorized->captured|failed, captured->refunded.';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER payments_guard_transition
  BEFORE UPDATE ON payments
  FOR EACH ROW EXECUTE FUNCTION payments_guard_transition();

-- THE HOT-PATH INDEX. Every authorization sums captured payments for a mandate
-- inside a time window. Partial (captured only) and composite (mandate, time)
-- so the planner reads exactly the rows it needs.
--
-- Section 9 of the phase doc records what happens when this stops being
-- enough: rollup counters, then a cache - in that order, and only after
-- measuring.
CREATE INDEX payments_spend_window_idx
  ON payments (mandate_id, captured_at DESC)
  WHERE status = 'captured';

-- Operations: payments stuck mid-flight need reconciling against the provider.
CREATE INDEX payments_in_flight_idx
  ON payments (created_at)
  WHERE status IN ('created', 'authorized');

-- Webhook handling: a provider callback arrives with THEIR id, not ours.
CREATE INDEX payments_provider_payment_idx
  ON payments (provider, provider_payment_id)
  WHERE provider_payment_id IS NOT NULL;

COMMENT ON TABLE payments IS
  'Payment attempts. Mutable along a legal state path only. voucher_jti is '
  'UNIQUE, which makes single-use voucher redemption a database guarantee.';
