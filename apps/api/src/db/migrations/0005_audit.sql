-- ===========================================================================
-- 0005_audit.sql - the audit trail, and least privilege for the application
--
-- TWO HALVES, and the second is the more important one:
--
--   1. audit_events: the evidence store. Append-only, hash-chained. Columns
--      and integrity constraints live here; the hash COMPUTATION and the
--      verification endpoint are Phase 6.
--
--   2. The atl_app role: the application connects with INSERT/SELECT and no
--      UPDATE, DELETE or TRUNCATE on any append-only table. Until now the
--      trigger has done all the work - but TRUNCATE requires table OWNERSHIP,
--      so the trigger's remaining gap is only closed by keeping the
--      application away from owner privileges.
--
-- Both, on purpose. The revoked grant stops application bugs; the trigger
-- stops a misconfigured grant. They fail independently, which is what defence
-- in depth actually means.
--
-- IMMUTABLE ONCE APPLIED.
-- ===========================================================================


-- ---------------------------------------------------------------------------
-- audit_events
--
-- Every consequential thing that happens gets a row: mandate created,
-- mandate revoked, agent registered, authorization requested, decision made,
-- voucher minted, payment attempted, payment captured, report generated,
-- audit data accessed.
--
-- ON `seq` AND WHY GAPS ARE NOT EVIDENCE OF TAMPERING:
--
-- seq is a BIGSERIAL, used for ordering and for reading the chain in order.
-- It is NOT an integrity mechanism. PostgreSQL sequences do not roll back: an
-- aborted transaction consumes its number permanently, so gaps appear during
-- entirely normal operation. A "sequence gap detector" would raise a false
-- alarm on every rolled-back transaction.
--
-- THE HASH CHAIN IS THE AUTHORITY. Each row commits to its predecessor, so
-- altering or removing an earlier row breaks every hash after it. That is
-- detectable; a missing sequence number is not meaningful on its own.
-- ---------------------------------------------------------------------------
CREATE TABLE audit_events (
  -- Ordering and chain traversal only. See the note above.
  seq                 BIGSERIAL   PRIMARY KEY,

  -- Stable public identifier, safe to quote in a report or a support ticket.
  id                  TEXT        NOT NULL UNIQUE,

  -- Allows separate chains later (for example one per merchant, so one
  -- merchant's verification does not require reading everyone else's events).
  -- One chain for the MVP.
  chain_id            TEXT        NOT NULL DEFAULT 'main',

  event_type          TEXT        NOT NULL,
  occurred_at         TIMESTAMPTZ NOT NULL DEFAULT now(),

  -- WHO did it. Attribution is the FREE-AI Accountability sutra in practice:
  -- every recorded action must be traceable to a responsible party.
  actor_kind          TEXT        NOT NULL,
  actor_id            TEXT,

  -- WHAT it was done to.
  subject_kind        TEXT        NOT NULL,
  subject_id          TEXT        NOT NULL,

  -- Ties this evidence row to the application logs for the same request.
  request_id          TEXT,

  -- Denormalised for filtering ("show me this mandate's trail"). Nullable
  -- because some events (agent registered) belong to no mandate.
  mandate_id          TEXT,

  -- THE HASHED CONTENT. Must be SELF-CONTAINED: verifying a hash cannot
  -- depend on joining to other tables, because those tables may themselves
  -- have changed since. This is the one place we deliberately snapshot data
  -- that exists elsewhere - see PHASE_02 Q5.
  payload             JSONB       NOT NULL,

  -- SHA-256 over the canonical serialisation of `payload`. Canonical because
  -- {"a":1,"b":2} and {"b":2,"a":1} are the same object but different bytes,
  -- and a chain that depends on key order breaks on a library upgrade.
  payload_hash        TEXT        NOT NULL,

  -- The link. NULL only for the first row in a chain.
  prev_hash           TEXT,

  -- SHA-256 over (prev_hash || payload_hash). UNIQUE: two rows cannot claim
  -- the same position in the chain.
  hash                TEXT        NOT NULL UNIQUE,

  hash_algorithm      TEXT        NOT NULL DEFAULT 'sha256',

  CONSTRAINT audit_events_id_format
    CHECK (id ~ '^evt_[a-z0-9_]{2,40}$'),

  CONSTRAINT audit_events_event_type_format
    CHECK (event_type ~ '^[A-Z][A-Z0-9_]{2,60}$'),

  CONSTRAINT audit_events_actor_kind_valid
    CHECK (actor_kind IN ('user', 'agent', 'system', 'admin')),

  CONSTRAINT audit_events_subject_kind_valid
    CHECK (subject_kind IN ('mandate', 'mandate_version', 'agent', 'user',
                            'authorization_request', 'decision', 'payment',
                            'report', 'audit')),

  -- Only 'system' may be anonymous. A user, agent or admin action with no
  -- actor id is an unattributable record, which is not evidence.
  CONSTRAINT audit_events_actor_attributed
    CHECK (actor_kind = 'system' OR actor_id IS NOT NULL),

  -- The payload must be a JSON OBJECT, not a bare string, number or array.
  -- Without this, `payload` could be `"null"` and still satisfy NOT NULL -
  -- JSONB null is a value, not an absence.
  CONSTRAINT audit_events_payload_is_object
    CHECK (jsonb_typeof(payload) = 'object'),

  CONSTRAINT audit_events_payload_not_empty
    CHECK (payload <> '{}'::jsonb),

  -- 64 lowercase hex characters: a real SHA-256 digest.
  CONSTRAINT audit_events_hash_format
    CHECK (hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT audit_events_payload_hash_format
    CHECK (payload_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT audit_events_prev_hash_format
    CHECK (prev_hash IS NULL OR prev_hash ~ '^[0-9a-f]{64}$'),

  -- A row cannot point at itself as its own predecessor.
  CONSTRAINT audit_events_no_self_link
    CHECK (prev_hash IS NULL OR prev_hash <> hash),

  CONSTRAINT audit_events_hash_algorithm_supported
    CHECK (hash_algorithm = 'sha256')
);

-- ---------------------------------------------------------------------------
-- Chain integrity, enforced by indexes rather than by application code.
-- ---------------------------------------------------------------------------

-- EXACTLY ONE genesis row per chain. Without this, an attacker could start a
-- second, parallel "valid-looking" chain and present it as the real one.
CREATE UNIQUE INDEX audit_events_single_genesis_idx
  ON audit_events (chain_id) WHERE prev_hash IS NULL;

-- NO FORKS: a given hash may be the predecessor of at most ONE row. Otherwise
-- the chain could branch, and two divergent histories would both verify.
CREATE UNIQUE INDEX audit_events_no_fork_idx
  ON audit_events (chain_id, prev_hash) WHERE prev_hash IS NOT NULL;

-- Chain traversal in order.
CREATE INDEX audit_events_chain_seq_idx ON audit_events (chain_id, seq);

-- "Show me this mandate's trail" - the dashboard's audit view.
CREATE INDEX audit_events_by_mandate_idx
  ON audit_events (mandate_id, occurred_at DESC) WHERE mandate_id IS NOT NULL;

-- Reporting and investigation by event type over a period.
CREATE INDEX audit_events_by_type_idx ON audit_events (event_type, occurred_at DESC);

-- Correlate evidence with application logs.
CREATE INDEX audit_events_by_request_idx
  ON audit_events (request_id) WHERE request_id IS NOT NULL;

-- APPEND-ONLY, both trigger kinds (TRUNCATE does not fire row-level triggers).
CREATE TRIGGER audit_events_append_only
  BEFORE UPDATE OR DELETE ON audit_events
  FOR EACH ROW EXECUTE FUNCTION reject_mutation();

CREATE TRIGGER audit_events_no_truncate
  BEFORE TRUNCATE ON audit_events
  FOR EACH STATEMENT EXECUTE FUNCTION reject_truncate();

COMMENT ON TABLE audit_events IS
  'Append-only, hash-chained evidence. seq is for ordering only - sequence '
  'gaps are normal (sequences do not roll back) and are NOT tamper evidence. '
  'The hash chain is the authority.';


-- ===========================================================================
-- LEAST PRIVILEGE: the atl_app application role
--
-- The application must not hold privileges it does not need. Specifically it
-- must be unable to UPDATE or DELETE anything append-only, and unable to
-- TRUNCATE anything at all (TRUNCATE needs ownership, which it will not have).
--
-- Migrations run as the OWNER; the running service connects as atl_app. That
-- separation is standard in production and is also what makes the Phase 6
-- tamper demonstration honest: to tamper with the audit trail we must
-- deliberately switch to the owner role, which is precisely the privileged
-- insider threat we claim to detect.
--
-- No password is set here - a password in a committed migration is a leaked
-- secret. Local development relies on Homebrew PostgreSQL's default trust
-- authentication; a real deployment assigns credentials out of band.
-- ===========================================================================

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'atl_app') THEN
    CREATE ROLE atl_app LOGIN;
  END IF;
END
$$;

-- Reach the schema, but not create in it.
GRANT USAGE ON SCHEMA public TO atl_app;
REVOKE CREATE ON SCHEMA public FROM atl_app;

-- Baseline: read and append everywhere.
GRANT SELECT, INSERT ON ALL TABLES IN SCHEMA public TO atl_app;

-- BIGSERIAL columns need the underlying sequence to insert.
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO atl_app;

-- UPDATE only where a legitimate lifecycle exists:
--   users/agents/merchants  profile and status changes
--   mandates                revocation
--   payments                the state machine (trigger-guarded)
--   agent_credentials       last_used_at, revocation
--   tools                   description changes
GRANT UPDATE ON users, agents, merchants, mandates, payments, agent_credentials, tools
  TO atl_app;

-- Explicit REVOKE on every append-only table.
--
-- Technically redundant, since UPDATE and DELETE were never granted above -
-- but a security boundary should be stated, not inferred. If someone later
-- adds a broad GRANT, these lines are the record of intent, and reviewers can
-- see the boundary without reconstructing it from what is absent.
REVOKE UPDATE, DELETE ON
  mandate_versions,
  mandate_version_merchants,
  authorization_requests,
  decisions,
  rule_evaluations,
  risk_signals,
  audit_events
  FROM atl_app;

-- The application never deletes anything, anywhere.
REVOKE DELETE ON ALL TABLES IN SCHEMA public FROM atl_app;

-- The migration ledger is not application data. Read-only, so a health check
-- can report the applied schema version without being able to rewrite history.
REVOKE ALL ON schema_migrations FROM atl_app;
GRANT SELECT ON schema_migrations TO atl_app;

-- Tables created by FUTURE migrations get the same baseline automatically.
-- Without this, migration 0006 would silently create a table the application
-- cannot read - a failure that appears at runtime, not at migration time.
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT SELECT, INSERT ON TABLES TO atl_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO atl_app;

COMMENT ON ROLE atl_app IS
  'Application runtime role. SELECT/INSERT broadly, UPDATE only on tables with '
  'a real lifecycle, never DELETE, never TRUNCATE, never DDL. Migrations run '
  'as the owner instead.';
