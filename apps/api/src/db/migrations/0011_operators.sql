-- ===========================================================================
-- 0011_operators.sql - human operators, sessions and roles
--
-- Closes gap ATL-C22, which the coverage report has been printing on a screen
-- since Phase 8: "mandate mutation is guarded by ONE SHARED ADMIN KEY with no
-- rotation and no per-caller identity, so createdBy records a CLAIM about who
-- acted, not a verified identity."
--
-- TWO TABLES, AND THE SECOND ONE IS WHERE THE CARE GOES.
--
-- `operators` stores a PASSWORD HASH. We must never be able to recover a
-- password, so it is hashed with scrypt - deliberately slow and memory-hard, so
-- an attacker holding this table cannot brute-force it cheaply.
--
-- `operator_sessions` stores a HASH OF THE SESSION TOKEN, not the token. A
-- session token is a BEARER CREDENTIAL: anyone holding it IS the user. Storing
-- it in plaintext would mean a database dump hands an attacker live sessions
-- for every logged-in operator.
--
-- NOTE THE CONTRAST WITH agent_credentials (migration 0002), which stores a
-- PUBLIC KEY and no secret at all. Three different storage decisions, one rule:
-- ask what the verifier needs. Recompute a MAC -> you need the key. Compare a
-- presented secret -> store a hash. Verify a signature -> store only the public
-- half.
--
-- IMMUTABLE ONCE APPLIED.
-- ===========================================================================

CREATE TABLE operators (
  id                TEXT        PRIMARY KEY,

  -- Lowercased at the application boundary so 'A@x.com' and 'a@x.com' cannot
  -- become two accounts. UNIQUE, so they cannot anyway.
  email             TEXT        NOT NULL UNIQUE,
  display_name      TEXT        NOT NULL,

  -- scrypt: 'scrypt$N$r$p$salt$hash', all base64. Parameters are stored WITH
  -- the hash so they can be raised later without invalidating existing
  -- passwords - a hash that cannot record its own cost is a hash you can never
  -- strengthen.
  password_hash     TEXT        NOT NULL,

  -- viewer     < compliance < admin. Ordered, and the ordering is enforced in
  -- code by an explicit rank rather than by string comparison.
  role              TEXT        NOT NULL DEFAULT 'viewer',

  status            TEXT        NOT NULL DEFAULT 'active',

  -- Operational: an account nobody uses should be disabled, and one suddenly
  -- used after months of silence should be investigated.
  last_login_at     TIMESTAMPTZ,
  -- Counted for lockout and for the security review. Reset on success.
  failed_logins     INTEGER     NOT NULL DEFAULT 0,
  locked_until      TIMESTAMPTZ,

  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT operators_id_format
    CHECK (id ~ '^opr_[a-z0-9_]{2,40}$'),

  -- Deliberately loose. Email validation by regex is a famous trap: the RFC
  -- grammar permits far more than any regex people actually write, and a strict
  -- pattern rejects real addresses. Shape only; the real check is that someone
  -- can receive mail there.
  CONSTRAINT operators_email_shape
    CHECK (email ~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$'
           AND email = lower(email)),

  CONSTRAINT operators_role_valid
    CHECK (role IN ('viewer', 'compliance', 'admin')),

  CONSTRAINT operators_status_valid
    CHECK (status IN ('active', 'suspended', 'disabled')),

  -- Guards against storing a plaintext password by mistake. A bare password
  -- cannot match this shape.
  CONSTRAINT operators_password_hash_shape
    CHECK (password_hash ~ '^scrypt\$[0-9]+\$[0-9]+\$[0-9]+\$[A-Za-z0-9+/=]+\$[A-Za-z0-9+/=]+$'),

  CONSTRAINT operators_display_name_not_blank
    CHECK (length(trim(display_name)) > 0),

  CONSTRAINT operators_failed_logins_non_negative
    CHECK (failed_logins >= 0)
);

CREATE TRIGGER operators_set_updated_at
  BEFORE UPDATE ON operators
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

COMMENT ON TABLE operators IS
  'Human operators. Passwords are scrypt hashes with their parameters stored '
  'alongside, so cost can be raised later without invalidating them.';


-- ---------------------------------------------------------------------------
-- operator_sessions
--
-- REVOCABLE BY DESIGN, and that is why these are sessions rather than JWTs. A
-- JWT is valid until it expires; a session can be killed NOW. For a system
-- whose requirements include "revoke this operator immediately", expiry-only
-- invalidation is the wrong default.
--
-- The cost is a database read per request. At this scale that is a primary-key
-- lookup on an indexed column.
-- ---------------------------------------------------------------------------
CREATE TABLE operator_sessions (
  id                TEXT        PRIMARY KEY,

  operator_id       TEXT        NOT NULL REFERENCES operators (id) ON DELETE RESTRICT,

  -- SHA-256 of the token the client holds. NEVER the token itself.
  token_hash        TEXT        NOT NULL UNIQUE,

  -- Recorded for the security review: "this session started from a new place".
  -- Both are attacker-controllable hints, never used for authorization.
  ip                TEXT,
  user_agent        TEXT,

  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at        TIMESTAMPTZ NOT NULL,
  last_seen_at      TIMESTAMPTZ NOT NULL DEFAULT now(),

  -- Set on logout or administrative revocation. Checked on every request, so
  -- revocation takes effect on the next call rather than at expiry.
  revoked_at        TIMESTAMPTZ,
  revoked_reason    TEXT,

  CONSTRAINT operator_sessions_id_format
    CHECK (id ~ '^ses_[a-z0-9_]{2,40}$'),

  CONSTRAINT operator_sessions_token_hash_format
    CHECK (token_hash ~ '^[0-9a-f]{64}$'),

  CONSTRAINT operator_sessions_expiry_after_creation
    CHECK (expires_at > created_at),

  CONSTRAINT operator_sessions_revocation_explained
    CHECK (revoked_at IS NULL OR revoked_reason IS NOT NULL),

  -- Bounded, because these come from an untrusted client and are stored.
  CONSTRAINT operator_sessions_user_agent_bounded
    CHECK (user_agent IS NULL OR length(user_agent) <= 400),
  CONSTRAINT operator_sessions_ip_bounded
    CHECK (ip IS NULL OR length(ip) <= 64)
);

-- The hot path: every authenticated request looks up by token hash. Partial,
-- because authentication only ever cares about live sessions.
CREATE INDEX operator_sessions_live_idx
  ON operator_sessions (token_hash) WHERE revoked_at IS NULL;

-- "Show me this operator's sessions" - the revoke-everything screen.
CREATE INDEX operator_sessions_by_operator_idx
  ON operator_sessions (operator_id, created_at DESC);

CREATE TRIGGER operator_sessions_no_delete
  BEFORE DELETE ON operator_sessions
  FOR EACH ROW EXECUTE FUNCTION reject_mutation();

CREATE TRIGGER operator_sessions_no_truncate
  BEFORE TRUNCATE ON operator_sessions
  FOR EACH STATEMENT EXECUTE FUNCTION reject_truncate();

GRANT UPDATE ON operators, operator_sessions TO atl_app;

COMMENT ON TABLE operator_sessions IS
  'Revocable sessions. Stores a SHA-256 of the bearer token, never the token: '
  'a database dump must not hand an attacker live sessions.';
