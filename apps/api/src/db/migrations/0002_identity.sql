-- ===========================================================================
-- 0002_identity.sql - users, agents, tools, tool grants, agent credentials
--
-- Who exists and what they are allowed to be. No mandates yet (0003) and no
-- authorization yet (0004) - this migration only establishes identity.
--
-- IMMUTABLE ONCE APPLIED. Changes go in a later migration.
-- ===========================================================================


-- ---------------------------------------------------------------------------
-- Shared helper: keep updated_at honest.
--
-- Defined once and attached to every mutable table, so the next person to
-- write an UPDATE cannot forget it. Doing this in application code means
-- relying on every future call site; doing it here means it always happens,
-- including from psql.
-- ---------------------------------------------------------------------------
CREATE FUNCTION set_updated_at() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

COMMENT ON FUNCTION set_updated_at IS
  'BEFORE UPDATE trigger: stamps updated_at = now() on the incoming row.';


-- ---------------------------------------------------------------------------
-- users
--
-- The human who authorises an agent to spend.
--
-- DPDP DATA MINIMISATION IS ENFORCED BY THE SHAPE OF THIS TABLE, not by a
-- policy document. There is physically nowhere to put a full phone number or
-- a full UPI VPA:
--   * the real-world identifier is stored ONLY as a SHA-256 hash
--   * the phone is stored as its last 4 digits (CHECKed to be exactly 4)
--   * the VPA is stored pre-masked, plus the bank handle, which is not
--     personal data on its own
--
-- Data never collected cannot leak, cannot be subpoenaed and cannot be
-- mishandled. It is the only privacy control that is absolute rather than
-- best-effort - everything else (encryption, access control, redaction)
-- reduces risk without eliminating it.
-- ---------------------------------------------------------------------------
CREATE TABLE users (
  id                  TEXT        PRIMARY KEY,

  -- SHA-256 (64 hex chars) of the upstream identifier. We can recognise a
  -- returning user without ever storing who they are.
  external_ref_hash   TEXT        NOT NULL UNIQUE,

  -- A label for dashboards. Seeded fixtures use obvious pseudonyms.
  display_name        TEXT        NOT NULL,

  -- Masked contact details only.
  phone_last4         TEXT,
  upi_vpa_masked      TEXT,
  upi_handle          TEXT,

  -- Bank details resolved from Razorpay's public IFSC API at seed/registration
  -- time (a cold path - never called during authorization; see ADR-0013).
  bank_ifsc           TEXT,
  bank_name           TEXT,
  bank_supports_upi   BOOLEAN,

  -- DPDP consent record. A single grant timestamp is enough for the MVP;
  -- a full consent ledger with withdrawals is Phase 10 (see PHASE_02 §12).
  consent_at          TIMESTAMPTZ,
  consent_purpose     TEXT,
  consent_version     TEXT,

  status              TEXT        NOT NULL DEFAULT 'active',

  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT users_id_format
    CHECK (id ~ '^usr_[a-z0-9_]{2,40}$'),

  -- Exactly 64 lowercase hex characters: a real SHA-256 digest, not a
  -- truncated one and not the plaintext identifier by mistake.
  CONSTRAINT users_ref_hash_is_sha256
    CHECK (external_ref_hash ~ '^[0-9a-f]{64}$'),

  -- Four digits, nothing more. A full 10-digit number cannot be stored here
  -- even if application code tried.
  CONSTRAINT users_phone_last4_format
    CHECK (phone_last4 IS NULL OR phone_last4 ~ '^[0-9]{4}$'),

  -- Must already be masked. '****@okhdfcbank' passes; 'darshana@okhdfcbank'
  -- does not.
  CONSTRAINT users_vpa_is_masked
    CHECK (upi_vpa_masked IS NULL OR upi_vpa_masked ~ '^\*{2,}@[a-z0-9.\-]{2,64}$'),

  -- Standard IFSC shape: 4 bank letters, a 0, then 6 branch characters.
  CONSTRAINT users_ifsc_format
    CHECK (bank_ifsc IS NULL OR bank_ifsc ~ '^[A-Z]{4}0[A-Z0-9]{6}$'),

  CONSTRAINT users_status_valid
    CHECK (status IN ('active', 'suspended', 'deleted')),

  CONSTRAINT users_display_name_not_blank
    CHECK (length(trim(display_name)) > 0),

  -- Consent is all-or-nothing: a purpose without a timestamp, or a timestamp
  -- without a purpose, is not a usable consent record.
  CONSTRAINT users_consent_complete
    CHECK ((consent_at IS NULL) = (consent_purpose IS NULL))
);

CREATE TRIGGER users_set_updated_at
  BEFORE UPDATE ON users
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

COMMENT ON TABLE users IS
  'Humans who authorise agents. Stores only minimised/masked personal data: '
  'hashed external reference, last 4 phone digits, pre-masked VPA.';


-- ---------------------------------------------------------------------------
-- agents
--
-- A program acting on a user''s behalf. Identity only - what it is ALLOWED to
-- do lives in agent_tool_grants, and what it may SPEND lives in mandates.
--
-- This is the "Know Your Agent" registry the FREE-AI Capacity pillar talks
-- about, at MVP scale: creator, version and declared capabilities recorded so
-- an action can always be attributed to a specific agent build.
-- ---------------------------------------------------------------------------
CREATE TABLE agents (
  id              TEXT        PRIMARY KEY,

  display_name    TEXT        NOT NULL,

  -- Who built it. Attribution matters for the FREE-AI Accountability sutra:
  -- a decision must be traceable to a responsible party.
  vendor          TEXT        NOT NULL,

  -- The specific model behind it, where known. Free text on purpose - we do
  -- not control the vendors' naming and must not reject an unknown model.
  model_id        TEXT,

  -- The agent build's own version. An agent that changes behaviour should
  -- change version, so audit records point at what actually ran.
  agent_version   TEXT        NOT NULL,

  status          TEXT        NOT NULL DEFAULT 'active',

  registered_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  suspended_at    TIMESTAMPTZ,

  CONSTRAINT agents_id_format
    CHECK (id ~ '^agt_[a-z0-9_]{2,40}$'),

  CONSTRAINT agents_status_valid
    CHECK (status IN ('active', 'suspended', 'revoked')),

  CONSTRAINT agents_names_not_blank
    CHECK (length(trim(display_name)) > 0 AND length(trim(vendor)) > 0
           AND length(trim(agent_version)) > 0),

  -- A suspended or revoked agent must record when. Cross-column invariants
  -- like this catch the half-finished state change that application code
  -- forgets under an error path.
  CONSTRAINT agents_suspension_timestamped
    CHECK (status = 'active' OR suspended_at IS NOT NULL)
);

CREATE TRIGGER agents_set_updated_at
  BEFORE UPDATE ON agents
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

COMMENT ON TABLE agents IS
  'Registered agents (Know-Your-Agent registry). Capabilities live in '
  'agent_tool_grants; spending authority lives in mandates.';


-- ---------------------------------------------------------------------------
-- tools
--
-- The catalogue of operations an agent can be granted. A REFERENCE TABLE, not
-- an enum and not a hardcoded list, for one specific reason: it lets the
-- foreign key below reject a grant for a tool that does not exist.
--
-- With `allowed_tools TEXT[]` on agents instead, a typo like 'serch_products'
-- would be stored happily and the agent would silently lose a capability -
-- a bug that looks like a model failure rather than a data-entry error.
--
-- Adding a real tool in Phase 8 is then an INSERT, not a migration.
-- ---------------------------------------------------------------------------
CREATE TABLE tools (
  name          TEXT        PRIMARY KEY,

  description   TEXT        NOT NULL,

  -- Sensitive tools are ones we expect to grant rarely and audit closely
  -- (anything touching mandates, audit records or bulk export). Used by the
  -- dashboard to highlight an unusual grant, and by Phase 11 review.
  is_sensitive  BOOLEAN     NOT NULL DEFAULT false,

  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT tools_name_format
    CHECK (name ~ '^[a-z][a-z0-9_]{2,40}$'),

  CONSTRAINT tools_description_not_blank
    CHECK (length(trim(description)) > 0)
);

COMMENT ON TABLE tools IS
  'Catalogue of grantable agent operations. Referenced by agent_tool_grants '
  'so an unknown tool name cannot be granted.';


-- ---------------------------------------------------------------------------
-- agent_tool_grants
--
-- Which agent may call which tool. This is the tool-level authorization that
-- stops a shopping agent from calling an audit-mutating tool at all - the
-- request is refused before any model output is considered.
--
-- Composite primary key (agent_id, tool_name): a grant is the pair, and the
-- PK makes a duplicate grant impossible rather than merely unusual.
-- ---------------------------------------------------------------------------
CREATE TABLE agent_tool_grants (
  -- ON DELETE RESTRICT, never CASCADE.
  --
  -- CASCADE would mean deleting an agent silently deletes its grants, and by
  -- the same pattern later its decisions and audit events. In a system whose
  -- product IS evidence, cascading deletes are a mechanism for destroying
  -- evidence by accident. RESTRICT forces the deletion to be dealt with
  -- explicitly, in the open.
  agent_id    TEXT        NOT NULL REFERENCES agents (id) ON DELETE RESTRICT,
  tool_name   TEXT        NOT NULL REFERENCES tools (name) ON DELETE RESTRICT,

  granted_at  TIMESTAMPTZ NOT NULL DEFAULT now(),

  -- Who granted it. 'seed' for fixtures, later a user or admin id. Needed to
  -- answer "who gave this agent that capability?" during an investigation.
  granted_by  TEXT        NOT NULL,

  PRIMARY KEY (agent_id, tool_name),

  CONSTRAINT agent_tool_grants_granted_by_not_blank
    CHECK (length(trim(granted_by)) > 0)
);

-- The PK already indexes (agent_id, tool_name), which serves "what may this
-- agent do?" - the question asked on every tool call. This second index
-- serves the reverse, "who can call this tool?", which is the question asked
-- during a security review of a sensitive tool.
CREATE INDEX agent_tool_grants_by_tool_idx ON agent_tool_grants (tool_name);

COMMENT ON TABLE agent_tool_grants IS
  'Tool-level authorization: which agent may invoke which tool.';


-- ---------------------------------------------------------------------------
-- agent_credentials
--
-- How an agent proves it is itself when calling our API.
--
-- ED25519, ASYMMETRIC, ON PURPOSE. The agent generates a keypair, keeps the
-- private key, and registers only the public key here. We verify signatures
-- with it and hold NO SECRET AT REST - so a database breach cannot be used to
-- forge requests from any agent.
--
-- An earlier draft planned an HMAC shared secret stored as an argon2 hash.
-- That does not work: verifying an HMAC requires recomputing it, which
-- requires the actual key. Hash-only storage is correct for passwords (the
-- client sends the secret and we compare hashes), not for request signing.
-- See ADR-0014.
--
-- Rule of thumb: pick symmetric vs asymmetric by asking who needs to verify.
-- One party doing both -> symmetric (our payment voucher, Phase 5). Two
-- parties where one must not be able to impersonate the other -> asymmetric.
-- ---------------------------------------------------------------------------
CREATE TABLE agent_credentials (
  id                      TEXT        PRIMARY KEY,

  agent_id                TEXT        NOT NULL REFERENCES agents (id) ON DELETE RESTRICT,

  -- Public identifier the agent sends in the X-ATL-Key header. Not a secret;
  -- it only tells us which public key to verify against.
  key_id                  TEXT        NOT NULL UNIQUE,

  -- Recorded explicitly so a future algorithm migration is a data change with
  -- an audit trail, rather than an assumption buried in code.
  algorithm               TEXT        NOT NULL DEFAULT 'ed25519',

  -- Base64 DER SPKI. An Ed25519 public key is 44 DER bytes, which encodes to
  -- exactly 60 base64 characters (59 + one '=' pad). Verified by measurement,
  -- not by assumption - an earlier draft guessed 44 and rejected every valid
  -- key.
  public_key_spki_b64     TEXT        NOT NULL,

  -- SHA-256 of the key bytes: a short, comparable identity for the key that is
  -- safe to display in a dashboard and to record in audit events.
  public_key_fingerprint  TEXT        NOT NULL UNIQUE,

  status                  TEXT        NOT NULL DEFAULT 'active',

  created_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at              TIMESTAMPTZ,
  revoked_at              TIMESTAMPTZ,

  -- Updated on use. Lets us spot a credential nobody uses (revoke it) and one
  -- suddenly used after months of silence (investigate it).
  last_used_at            TIMESTAMPTZ,

  CONSTRAINT agent_credentials_id_format
    CHECK (id ~ '^cred_[a-z0-9_]{2,40}$'),

  CONSTRAINT agent_credentials_key_id_format
    CHECK (key_id ~ '^akid_[A-Za-z0-9_-]{8,64}$'),

  -- Only Ed25519 for now. Widening this is a deliberate migration, not a
  -- silent acceptance of a weaker algorithm.
  CONSTRAINT agent_credentials_algorithm_supported
    CHECK (algorithm = 'ed25519'),

  CONSTRAINT agent_credentials_fingerprint_is_sha256
    CHECK (public_key_fingerprint ~ '^[0-9a-f]{64}$'),

  -- Guards against storing a private key, an empty string, a PEM blob or a
  -- shared secret by mistake. A PKCS#8 private key is far longer, so the
  -- exact length alone rules it out.
  CONSTRAINT agent_credentials_public_key_shape
    CHECK (public_key_spki_b64 ~ '^[A-Za-z0-9+/]{59}=$'),

  CONSTRAINT agent_credentials_status_valid
    CHECK (status IN ('active', 'revoked', 'expired')),

  -- A credential cannot claim to be revoked without recording when.
  CONSTRAINT agent_credentials_revocation_timestamped
    CHECK (status <> 'revoked' OR revoked_at IS NOT NULL),

  CONSTRAINT agent_credentials_expiry_after_creation
    CHECK (expires_at IS NULL OR expires_at > created_at)
);

-- Every authenticated request looks up by key_id (already unique-indexed) and
-- then needs the agent. This serves "list the credentials for this agent".
CREATE INDEX agent_credentials_by_agent_idx ON agent_credentials (agent_id);

-- Partial index: authentication only ever cares about active credentials, so
-- index only those. Smaller, faster, and cheaper to maintain on write.
CREATE INDEX agent_credentials_active_idx
  ON agent_credentials (key_id) WHERE status = 'active';

COMMENT ON TABLE agent_credentials IS
  'Ed25519 public keys used to verify agent request signatures. No secret is '
  'stored: the agent holds the private key.';
