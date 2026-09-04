-- ===========================================================================
-- 0003_mandates.sql - mandates, immutable mandate versions, merchant allowlist
--
-- THE CENTRAL GUARANTEE OF THIS MIGRATION:
--   A decision made last Tuesday must remain explainable against the mandate
--   AS IT WAS last Tuesday.
--
-- If a user later raises their per-transaction limit from ₹2,000 to ₹5,000,
-- last Tuesday's BLOCK must still read "exceeded the ₹2,000 limit". Otherwise
-- the audit trail becomes a lie: it claims a payment was blocked for exceeding
-- a limit that it did not exceed.
--
-- We make that structural rather than procedural. Terms live in
-- mandate_versions, which is APPEND-ONLY - there is no code path that could
-- lose old terms, because nothing is ever able to update them.
--
-- IMMUTABLE ONCE APPLIED.
-- ===========================================================================


-- ---------------------------------------------------------------------------
-- Shared helper: refuse mutation of an append-only table.
--
-- Raises a CUSTOM SQLSTATE ('ATL01') rather than relying on the message text,
-- so tests and application code can assert on a stable machine-readable code.
-- Asserting on a message string is how you write a test that keeps passing
-- after the behaviour it checks has changed.
--
-- This is one half of our append-only defence. The other half is a database
-- role without UPDATE/DELETE rights (migration 0005). Both, on purpose: the
-- revoked grant stops application bugs, the trigger stops a misconfigured
-- grant, and they fail independently.
-- ---------------------------------------------------------------------------
CREATE FUNCTION reject_mutation() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION
    '%.% is append-only; % is not permitted',
    TG_TABLE_SCHEMA, TG_TABLE_NAME, TG_OP
    USING ERRCODE = 'ATL01',
          HINT = 'Insert a superseding row instead of modifying an existing one.';
END;
$$;

COMMENT ON FUNCTION reject_mutation IS
  'BEFORE UPDATE OR DELETE trigger for append-only tables. Raises SQLSTATE ATL01.';


-- ---------------------------------------------------------------------------
-- Shared helper: refuse TRUNCATE on an append-only table.
--
-- SEPARATE FUNCTION AND SEPARATE TRIGGER BECAUSE TRUNCATE DOES NOT FIRE
-- ROW-LEVEL TRIGGERS AT ALL. Verified by probe: a table with a BEFORE
-- UPDATE OR DELETE ... FOR EACH ROW trigger is emptied by TRUNCATE silently,
-- with no error and no trigger invocation.
--
-- Without this, `TRUNCATE audit_events;` would erase the entire audit trail
-- in one statement while our append-only trigger said nothing - which would
-- make the tamper-evidence claim hollow. TRUNCATE needs a STATEMENT-level
-- trigger.
--
-- Note what this also implies: the trigger half of our defence cannot be the
-- whole story, because TRUNCATE requires table ownership. The role half
-- (migration 0005) is what keeps the application away from owner privileges.
-- ---------------------------------------------------------------------------
CREATE FUNCTION reject_truncate() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION
    '%.% is append-only; TRUNCATE is not permitted',
    TG_TABLE_SCHEMA, TG_TABLE_NAME
    USING ERRCODE = 'ATL01',
          HINT = 'Append-only tables are never emptied. Drop and re-migrate a dev database instead.';
END;
$$;

COMMENT ON FUNCTION reject_truncate IS
  'BEFORE TRUNCATE, FOR EACH STATEMENT trigger for append-only tables. '
  'Required because TRUNCATE does not fire row-level triggers.';


-- ---------------------------------------------------------------------------
-- Domain: a Merchant Category Code.
--
-- A DOMAIN rather than a plain TEXT column because PostgreSQL applies a
-- domain''s CHECK to every ELEMENT of an array of that domain - verified by
-- probe before relying on it. That gives per-element validation of a
-- blocked-MCC list without a subquery (which CHECK constraints forbid).
--
-- ISO 18245. Examples we care about:
--   5411 grocery stores / supermarkets      5812 eating places / restaurants
--   5921 package stores: beer, wine, liquor 7995 betting / gambling
--   6012 financial institutions             4900 utilities
-- ---------------------------------------------------------------------------
CREATE DOMAIN mcc_code AS TEXT
  CONSTRAINT mcc_code_is_four_digits CHECK (VALUE ~ '^[0-9]{4}$');

COMMENT ON DOMAIN mcc_code IS
  'ISO 18245 Merchant Category Code: exactly four digits. Validated per array element.';


-- ---------------------------------------------------------------------------
-- mandates - identity and lifecycle ONLY
--
-- Deliberately holds no spending terms. It answers "does this authorisation
-- relationship exist, and is it still live?" Terms are in mandate_versions.
--
-- TWO THINGS ABSENT ON PURPOSE:
--
-- 1. No `current_version` column. Versions are append-only, so the current
--    version IS max(version). Storing it would create a circular foreign key
--    (mandates -> versions -> mandates) and, worse, a denormalised value that
--    can drift out of step with reality. A derived value that can be wrong is
--    worse than a subquery that cannot be.
--
-- 2. No 'expired' status. Expiry is time-based: an 'expired' value would need
--    a scheduled job to stay truthful, and until that job ran the row would
--    say 'active' while being past valid_to - a lie sitting in the database.
--    The policy engine computes expiry from valid_to at decision time anyway,
--    so storing it buys nothing and risks correctness.
--    RULE: never store state that the passage of time can invalidate.
-- ---------------------------------------------------------------------------
CREATE TABLE mandates (
  id              TEXT        PRIMARY KEY,

  -- RESTRICT, never CASCADE: deleting a user must not silently delete the
  -- authorisations they granted, nor the decisions and audit events hanging
  -- off them. Evidence is not garbage-collectable.
  user_id         TEXT        NOT NULL REFERENCES users (id)  ON DELETE RESTRICT,
  agent_id        TEXT        NOT NULL REFERENCES agents (id) ON DELETE RESTRICT,

  -- A short human label, e.g. "Weekly groceries". Shown in the dashboard and
  -- in the agent's explanation to the user.
  label           TEXT        NOT NULL,

  status          TEXT        NOT NULL DEFAULT 'active',

  -- Revocation is TERMINAL (enforced by trigger below). Un-revoking is not a
  -- state change; it is a new mandate.
  revoked_at      TIMESTAMPTZ,
  revoked_by      TEXT,
  revoked_reason  TEXT,

  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT mandates_id_format
    CHECK (id ~ '^mnd_[a-z0-9_]{2,40}$'),

  CONSTRAINT mandates_status_valid
    CHECK (status IN ('active', 'revoked')),

  CONSTRAINT mandates_label_not_blank
    CHECK (length(trim(label)) > 0),

  -- A revocation must record when, by whom and why. Half-recorded revocations
  -- are exactly what a dispute or an audit will ask about, and "we revoked it
  -- but did not note why" is not an answer.
  CONSTRAINT mandates_revocation_complete
    CHECK (
      status <> 'revoked'
      OR (revoked_at IS NOT NULL AND revoked_by IS NOT NULL AND revoked_reason IS NOT NULL)
    ),

  -- The converse: revocation fields must not be set on a live mandate.
  CONSTRAINT mandates_revocation_fields_only_when_revoked
    CHECK (
      status = 'revoked'
      OR (revoked_at IS NULL AND revoked_by IS NULL AND revoked_reason IS NULL)
    )
);

CREATE TRIGGER mandates_set_updated_at
  BEFORE UPDATE ON mandates
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Guard the lifecycle: identity is immutable and revocation is one-way.
CREATE FUNCTION mandates_guard_transition() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  -- The parties to an authorisation cannot be swapped after the fact. Allowing
  -- it would let a mandate's audit history be silently re-attributed to a
  -- different user or agent.
  IF NEW.user_id <> OLD.user_id OR NEW.agent_id <> OLD.agent_id THEN
    RAISE EXCEPTION 'mandate parties are immutable (user_id, agent_id cannot change)'
      USING ERRCODE = 'ATL02';
  END IF;

  -- Revocation is terminal. A user who wants to resume delegation grants a new
  -- mandate; reviving the old one would make its audit trail ambiguous about
  -- which period was authorised.
  IF OLD.status = 'revoked' AND NEW.status <> 'revoked' THEN
    RAISE EXCEPTION 'mandate revocation is terminal; issue a new mandate instead'
      USING ERRCODE = 'ATL02';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER mandates_guard_transition
  BEFORE UPDATE ON mandates
  FOR EACH ROW EXECUTE FUNCTION mandates_guard_transition();

-- Authorization looks up live mandates for a user+agent pair constantly.
CREATE INDEX mandates_user_agent_idx ON mandates (user_id, agent_id);
CREATE INDEX mandates_active_idx ON mandates (id) WHERE status = 'active';

COMMENT ON TABLE mandates IS
  'Authorisation relationship between a user and an agent. Identity and '
  'lifecycle only; spending terms live in mandate_versions.';


-- ---------------------------------------------------------------------------
-- mandate_versions - the terms. APPEND-ONLY.
--
-- Every field here is read by the policy engine, so every field is a real
-- column with real constraints. Our rule: anything a RULE reads is a column;
-- anything only a HUMAN reads may be JSONB (see `notes`).
-- ---------------------------------------------------------------------------
CREATE TABLE mandate_versions (
  mandate_id                  TEXT        NOT NULL REFERENCES mandates (id) ON DELETE RESTRICT,

  -- Starts at 1 and increases by 1. Concurrent attempts to create the same
  -- version collide on the primary key, which fails loudly rather than
  -- corrupting the sequence - the correct outcome.
  version                     INTEGER     NOT NULL,

  -- --- Amount limits (integer paise; see src/money.ts) -------------------
  per_txn_limit_paise         BIGINT      NOT NULL,
  window_limit_paise          BIGINT      NOT NULL,
  window_kind                 TEXT        NOT NULL,

  -- --- Velocity ----------------------------------------------------------
  max_txn_per_hour            INTEGER     NOT NULL,

  -- --- Category control (MCC-based, not product titles) ------------------
  -- MCC because a four-digit code assigned to the merchant is far harder to
  -- game than a product name an agent or a merchant can write freely.
  -- Domain-typed array: each element is validated as four digits.
  blocked_mccs                mcc_code[]  NOT NULL DEFAULT '{}',

  -- --- Time window (in the mandate's own timezone) -----------------------
  -- Storage is UTC (TIMESTAMPTZ) but a user means "8am to 8pm MY time".
  -- The timezone is stored explicitly so the conversion is a recorded fact
  -- rather than an assumption buried in application code - which is how a
  -- mandate silently stops working when the server moves or DST shifts.
  timezone                    TEXT        NOT NULL DEFAULT 'Asia/Kolkata',
  window_start_hour           SMALLINT    NOT NULL DEFAULT 0,
  window_end_hour             SMALLINT    NOT NULL DEFAULT 24,
  allowed_weekdays            TEXT[]      NOT NULL DEFAULT ARRAY['MON','TUE','WED','THU','FRI','SAT','SUN'],

  -- --- Validity ----------------------------------------------------------
  valid_from                  TIMESTAMPTZ NOT NULL,
  valid_to                    TIMESTAMPTZ NOT NULL,

  -- --- Payment methods ---------------------------------------------------
  payment_methods             TEXT[]      NOT NULL DEFAULT ARRAY['upi_reserve_pay'],

  -- --- Regulatory reference (INFORMATIONAL ONLY) -------------------------
  -- The NPCI AFA-exemption ceiling (circular UPI/OC-151A, 14 Dec 2023):
  -- ₹15,000 default, ₹1,00,000 for specific MCCs. This governs whether a UPI
  -- PIN is required, on a rail we do not operate - so we RECORD and DISPLAY
  -- it, we do not enforce it.
  --
  -- The research treats this threshold as a mandate spending cap. It is not:
  -- they are two different rules with two different owners. Keeping them
  -- separate is why our rule set is sharper than the source material's.
  afa_exemption_threshold_paise BIGINT    NOT NULL DEFAULT 10000000,

  -- --- Provenance --------------------------------------------------------
  created_at                  TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by                  TEXT        NOT NULL,
  change_reason               TEXT,

  -- Cryptographic signature over the canonical terms. Nullable until Phase 5,
  -- where key handling belongs. Honestly labelled rather than faked now.
  signature                   TEXT,
  signature_key_fingerprint   TEXT,

  -- Human-only annotations. JSONB is acceptable here precisely BECAUSE no
  -- rule reads it.
  notes                       JSONB,

  PRIMARY KEY (mandate_id, version),

  CONSTRAINT mandate_versions_version_positive
    CHECK (version >= 1),

  -- Money must be positive. A zero or negative limit is not a permissive
  -- mandate, it is a malformed one, and it should never be storable.
  CONSTRAINT mandate_versions_per_txn_limit_positive
    CHECK (per_txn_limit_paise > 0),
  CONSTRAINT mandate_versions_window_limit_positive
    CHECK (window_limit_paise > 0),

  -- A per-transaction limit above the window limit is incoherent: the second
  -- transaction could never succeed. Catching it here means the policy engine
  -- never has to reason about a contradictory mandate.
  CONSTRAINT mandate_versions_per_txn_within_window
    CHECK (per_txn_limit_paise <= window_limit_paise),

  CONSTRAINT mandate_versions_window_kind_valid
    CHECK (window_kind IN ('day', 'week', 'month')),

  CONSTRAINT mandate_versions_velocity_positive
    CHECK (max_txn_per_hour >= 1),

  -- 0..24 with end > start. 0-24 means "any time".
  CONSTRAINT mandate_versions_window_hours_valid
    CHECK (
      window_start_hour BETWEEN 0 AND 23
      AND window_end_hour BETWEEN 1 AND 24
      AND window_end_hour > window_start_hour
    ),

  -- Containment (<@) works inside a CHECK - verified by probe. Rejects a
  -- typo'd weekday, which would otherwise silently narrow the window.
  --
  -- cardinality(), NOT array_length(). array_length(ARRAY[]::text[], 1)
  -- returns NULL rather than 0, and a CHECK constraint PASSES when it
  -- evaluates to NULL (SQL three-valued logic) - so the array_length version
  -- silently ACCEPTED an empty list, producing a mandate that can never
  -- legally fire. cardinality() returns 0 for an empty array.
  -- Found by a test asserting the constraint name, not by inspection.
  CONSTRAINT mandate_versions_weekdays_valid
    CHECK (
      allowed_weekdays <@ ARRAY['MON','TUE','WED','THU','FRI','SAT','SUN']::TEXT[]
      AND cardinality(allowed_weekdays) >= 1
    ),

  CONSTRAINT mandate_versions_payment_methods_valid
    CHECK (
      payment_methods <@ ARRAY['upi_reserve_pay','upi_autopay','card','netbanking']::TEXT[]
      AND cardinality(payment_methods) >= 1
    ),

  CONSTRAINT mandate_versions_validity_ordered
    CHECK (valid_to > valid_from),

  CONSTRAINT mandate_versions_afa_threshold_positive
    CHECK (afa_exemption_threshold_paise > 0),

  CONSTRAINT mandate_versions_created_by_not_blank
    CHECK (length(trim(created_by)) > 0),

  -- A signature without the key that produced it cannot be verified, and a
  -- key reference without a signature is meaningless. All or nothing.
  CONSTRAINT mandate_versions_signature_complete
    CHECK ((signature IS NULL) = (signature_key_fingerprint IS NULL))
);

-- APPEND-ONLY. This is the guarantee the whole migration exists for.
-- Two triggers, because one statement type bypasses the other's trigger kind.
CREATE TRIGGER mandate_versions_append_only
  BEFORE UPDATE OR DELETE ON mandate_versions
  FOR EACH ROW EXECUTE FUNCTION reject_mutation();

CREATE TRIGGER mandate_versions_no_truncate
  BEFORE TRUNCATE ON mandate_versions
  FOR EACH STATEMENT EXECUTE FUNCTION reject_truncate();

-- "Give me the current terms for this mandate" runs on every authorization.
-- DESC so the newest version is the first index entry read.
CREATE INDEX mandate_versions_current_idx
  ON mandate_versions (mandate_id, version DESC);

COMMENT ON TABLE mandate_versions IS
  'Immutable spending terms. A new version supersedes rather than updates, so '
  'a past decision stays explainable against the terms it actually judged.';


-- ---------------------------------------------------------------------------
-- mandate_version_merchants - the merchant allowlist. APPEND-ONLY.
--
-- A JOIN TABLE WITH A FOREIGN KEY, not a TEXT[] column, for one specific
-- reason: a typo'd merchant id in an array becomes a PERMANENT SILENT BLOCK.
-- The agent is refused forever, the verdict looks correct ("merchant not in
-- allowlist"), and nothing anywhere indicates the allowlist itself is wrong.
-- That is the worst class of bug - invisible and self-justifying.
--
-- With a foreign key, allowlisting a merchant that does not exist is refused
-- at write time, where a human is present to read the error.
--
-- An empty allowlist means NO merchant is permitted (deny by default), not
-- "all merchants". The policy engine must treat absence as denial.
-- ---------------------------------------------------------------------------
CREATE TABLE mandate_version_merchants (
  mandate_id    TEXT        NOT NULL,
  version       INTEGER     NOT NULL,
  merchant_id   TEXT        NOT NULL REFERENCES merchants (id) ON DELETE RESTRICT,

  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),

  PRIMARY KEY (mandate_id, version, merchant_id),

  -- Composite FK to the exact version, so an allowlist entry can never be
  -- orphaned from the terms it belongs to.
  FOREIGN KEY (mandate_id, version)
    REFERENCES mandate_versions (mandate_id, version) ON DELETE RESTRICT
);

CREATE TRIGGER mandate_version_merchants_append_only
  BEFORE UPDATE OR DELETE ON mandate_version_merchants
  FOR EACH ROW EXECUTE FUNCTION reject_mutation();

CREATE TRIGGER mandate_version_merchants_no_truncate
  BEFORE TRUNCATE ON mandate_version_merchants
  FOR EACH STATEMENT EXECUTE FUNCTION reject_truncate();

-- Reverse lookup: "which mandates allow this merchant?" - asked when a
-- merchant is suspended and we need to find affected authorisations.
CREATE INDEX mandate_version_merchants_by_merchant_idx
  ON mandate_version_merchants (merchant_id);

COMMENT ON TABLE mandate_version_merchants IS
  'Merchant allowlist for one mandate version. Append-only. An empty '
  'allowlist denies every merchant (deny by default).';
