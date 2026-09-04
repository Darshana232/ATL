-- ===========================================================================
-- 0007_audit_checkpoints.sql - signed anchors over the hash chain
--
-- WHAT PROBLEM THIS SOLVES, precisely:
--
-- The hash chain detects a SINGLE edit, because altering one row breaks every
-- hash after it. It does NOT detect a CONSISTENT REWRITE: someone with
-- database superuser rights can recompute every row and every hash, and the
-- rewritten chain verifies perfectly.
--
-- A checkpoint records "at seq N, on this date, the head hash was H", together
-- with an HMAC over those facts. Faking history before a checkpoint now
-- requires forging that signature, which needs the SIGNING SECRET - not merely
-- database access.
--
-- THE HONEST LIMIT: this raises the bar from "can write to the database" to
-- "can write to the database AND exfiltrate a secret". It does not eliminate
-- the threat. Only anchoring the head hash somewhere WE DO NOT CONTROL - a
-- public transparency log, a counterparty, a published notice - makes rewriting
-- genuinely impossible, and that needs a counterparty we do not have in an MVP.
--
-- Our claim ceiling stays TAMPER-EVIDENT. Never tamper-proof.
--
-- IMMUTABLE ONCE APPLIED.
-- ===========================================================================

CREATE TABLE audit_checkpoints (
  id                TEXT        PRIMARY KEY,

  chain_id          TEXT        NOT NULL DEFAULT 'main',

  -- The chain position being anchored, and what the head looked like there.
  seq               BIGINT      NOT NULL,
  head_hash         TEXT        NOT NULL,

  -- How many events the chain contained at this point. A rewrite that SHORTENS
  -- history (dropping inconvenient events and renumbering) changes this even if
  -- the attacker gets the hashes internally consistent.
  event_count       BIGINT      NOT NULL,

  -- HMAC-SHA256 over the canonical serialisation of the facts above, using
  -- AUDIT_CHECKPOINT_SECRET.
  --
  -- A SEPARATE SECRET from VOUCHER_SIGNING_SECRET, deliberately. Different
  -- blast radius: leaking the voucher key lets someone mint a payment token,
  -- and it must not ALSO let them forge history. Key separation by purpose is
  -- nearly free and stops one compromise becoming two.
  signature         TEXT        NOT NULL,

  -- Recorded explicitly so a future algorithm change is a data change with an
  -- audit trail, rather than an assumption buried in code.
  signature_algorithm TEXT      NOT NULL DEFAULT 'hmac-sha256',

  -- Who or what asked for this checkpoint. 'system' for the scheduled job.
  created_by        TEXT        NOT NULL,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT audit_checkpoints_id_format
    CHECK (id ~ '^ckpt_[a-z0-9_]{2,40}$'),

  CONSTRAINT audit_checkpoints_head_hash_format
    CHECK (head_hash ~ '^[0-9a-f]{64}$'),

  CONSTRAINT audit_checkpoints_signature_format
    CHECK (signature ~ '^[0-9a-f]{64}$'),

  CONSTRAINT audit_checkpoints_algorithm_supported
    CHECK (signature_algorithm = 'hmac-sha256'),

  CONSTRAINT audit_checkpoints_seq_positive
    CHECK (seq > 0),

  CONSTRAINT audit_checkpoints_event_count_positive
    CHECK (event_count > 0),

  CONSTRAINT audit_checkpoints_created_by_not_blank
    CHECK (length(trim(created_by)) > 0),

  -- One checkpoint per position per chain. Two different checkpoints claiming
  -- different head hashes at the same seq would make the anchor ambiguous -
  -- and an ambiguous anchor anchors nothing.
  CONSTRAINT audit_checkpoints_one_per_position
    UNIQUE (chain_id, seq)
);

-- APPEND-ONLY, like every other evidence table. A checkpoint that can be
-- updated is not an anchor.
CREATE TRIGGER audit_checkpoints_append_only
  BEFORE UPDATE OR DELETE ON audit_checkpoints
  FOR EACH ROW EXECUTE FUNCTION reject_mutation();

CREATE TRIGGER audit_checkpoints_no_truncate
  BEFORE TRUNCATE ON audit_checkpoints
  FOR EACH STATEMENT EXECUTE FUNCTION reject_truncate();

-- "The most recent checkpoint for this chain" - read on every verification, so
-- verification can start from the last anchor instead of from genesis.
CREATE INDEX audit_checkpoints_latest_idx
  ON audit_checkpoints (chain_id, seq DESC);

-- The application appends checkpoints and reads them. It must never be able to
-- rewrite one - the default grants in 0005 already give SELECT and INSERT only,
-- but stating it here is the record of intent for a reviewer.
REVOKE UPDATE, DELETE ON audit_checkpoints FROM atl_app;

COMMENT ON TABLE audit_checkpoints IS
  'Signed anchors over the audit hash chain. Detect a consistent full-chain '
  'rewrite, which the chain alone cannot. Raises the bar to "database access '
  'AND secret exfiltration"; does not make the trail tamper-proof.';
