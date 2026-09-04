-- ===========================================================================
-- 0001_init.sql - merchants
--
-- The first table, chosen because it is the shallowest node in our dependency
-- graph: mandates need users, agents AND merchants; merchants need nobody.
-- Applying it proves the whole migration -> schema -> query -> test path works
-- before we commit to the harder parts of the data model.
--
-- IMMUTABLE ONCE APPLIED. Schema changes go in 0002_*.sql.
-- ===========================================================================

CREATE TABLE merchants (
  -- Prefixed text IDs, as used by Razorpay ("pay_", "order_") and Stripe.
  -- Self-describing in logs, and passing a merchant id where a mandate id
  -- belongs becomes visibly wrong rather than a silent integer mix-up.
  -- Merchants are few and human-curated, so we use readable slugs; entities we
  -- generate at volume will use prefix + random suffix.
  id             TEXT        PRIMARY KEY,

  -- Registered legal entity vs the name a user actually recognises. Compliance
  -- reports and STR drafts need the legal name; the dashboard shows the other.
  legal_name     TEXT        NOT NULL,
  display_name   TEXT        NOT NULL,

  -- ISO 18245 Merchant Category Code. The category blacklist rule (Phase 4)
  -- keys off MCC rather than free text, because "alcohol" as a string is
  -- guessable and gameable, while 5921 is not.
  --   5411 = grocery stores / supermarkets
  --   5812 = eating places / restaurants
  --   5921 = package stores: beer, wine, liquor
  --   7995 = betting / gambling
  mcc            TEXT        NOT NULL,

  -- Normalised internal category, derived from MCC. Denormalised on purpose:
  -- rules and dashboards filter on it constantly, and an MCC -> category
  -- lookup on every policy evaluation would be pure overhead.
  category       TEXT        NOT NULL,

  status         TEXT        NOT NULL DEFAULT 'active',

  -- TIMESTAMPTZ, never TIMESTAMP. TIMESTAMP carries no timezone, so
  -- "2026-09-04 14:22" is ambiguous - unacceptable in a record a regulator or
  -- a dispute process may have to read. TIMESTAMPTZ stores UTC.
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now(),

  -- CHECK constraints are defence in depth: the database is the last line.
  -- Application code has bugs and humans run psql; an invariant enforced here
  -- holds no matter how the row arrived.
  CONSTRAINT merchants_id_format
    CHECK (id ~ '^mer_[a-z0-9_]{2,40}$'),

  CONSTRAINT merchants_mcc_format
    CHECK (mcc ~ '^[0-9]{4}$'),

  -- TEXT + CHECK rather than a Postgres ENUM type: adding a status later is a
  -- one-line migration, whereas ALTER TYPE is awkward and removing an enum
  -- value is genuinely painful.
  CONSTRAINT merchants_status_valid
    CHECK (status IN ('active', 'suspended', 'offboarded')),

  CONSTRAINT merchants_names_not_blank
    CHECK (length(trim(legal_name)) > 0 AND length(trim(display_name)) > 0)
);

-- Index what you FILTER on, not everything. The category blacklist rule and
-- the dashboard both filter merchants by category; without this, Postgres
-- scans the whole table. (At 20 rows that is irrelevant - the point is to
-- build the habit while the cost of getting it wrong is zero.)
CREATE INDEX merchants_category_idx ON merchants (category);

-- Partial index: dashboard views almost always want active merchants only, so
-- we index just those rows. Smaller index, faster lookups, less write cost.
CREATE INDEX merchants_active_idx ON merchants (id) WHERE status = 'active';

COMMENT ON TABLE merchants IS
  'Merchants an agent may be authorised to transact with. Seeded for the MVP; '
  'in production this would mirror the payment aggregator''s merchant registry.';
