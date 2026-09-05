-- ===========================================================================
-- 0008_catalog.sql - the product catalog the agent shops from
--
-- WHY A TABLE RATHER THAN AN EXTERNAL API (ADR-0013 revisited):
--
-- DummyJSON and FakeStoreAPI both work and need no key, but they price in USD,
-- list US consumer goods, and carry NO MERCHANT CATEGORY CODE. Our
-- CATEGORY_BLOCKLIST rule keys on ISO 18245 MCCs, so a catalog without them
-- cannot exercise the rule at all. Hand-seeded Indian grocery and food fixtures
-- are more realistic AND have no network dependency.
--
-- A product belongs to a MERCHANT, and the merchant carries the MCC. That is
-- deliberate: category policy is a property of who you are paying, not of what
-- you claim to be selling. A merchant cannot dodge a category block by
-- relabelling a product.
--
-- IMMUTABLE ONCE APPLIED.
-- ===========================================================================

CREATE TABLE products (
  id                TEXT        PRIMARY KEY,

  merchant_id       TEXT        NOT NULL REFERENCES merchants (id) ON DELETE RESTRICT,

  -- The merchant's own SKU. Unique per merchant, not globally: two merchants
  -- may legitimately use the same code.
  sku               TEXT        NOT NULL,

  name              TEXT        NOT NULL,
  description       TEXT        NOT NULL DEFAULT '',

  -- Integer paise. Never a float: a cart total is a sum of integers, and
  -- 0.1 + 0.2 is famously not 0.3.
  unit_price_paise  BIGINT      NOT NULL,

  -- A coarse shelf label for search. NOT a policy input - policy reads the
  -- merchant's MCC. Naming this `category` and having it mean something
  -- different from the compliance category would be a trap, so the comment
  -- says so and no rule ever reads it.
  shelf             TEXT        NOT NULL DEFAULT 'general',

  unit              TEXT        NOT NULL DEFAULT 'each',
  in_stock          BOOLEAN     NOT NULL DEFAULT true,

  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT products_id_format
    CHECK (id ~ '^prd_[a-z0-9_]{2,40}$'),

  CONSTRAINT products_sku_format
    CHECK (sku ~ '^[a-z0-9][a-z0-9._-]{1,63}$'),

  CONSTRAINT products_name_not_blank
    CHECK (length(trim(name)) > 0),

  -- Bounded, because this text is read by a LANGUAGE MODEL and rendered in a
  -- dashboard. Unbounded free text from a merchant is both a storage problem
  -- and a prompt-injection surface.
  CONSTRAINT products_name_bounded
    CHECK (length(name) <= 200),
  CONSTRAINT products_description_bounded
    CHECK (length(description) <= 2000),

  CONSTRAINT products_price_positive
    CHECK (unit_price_paise > 0),

  CONSTRAINT products_sku_unique_per_merchant
    UNIQUE (merchant_id, sku)
);

CREATE TRIGGER products_set_updated_at
  BEFORE UPDATE ON products
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- "What does this merchant sell?" - the agent's search, scoped to merchants the
-- mandate actually allows.
CREATE INDEX products_by_merchant_idx ON products (merchant_id, shelf);

-- Simple text search over name and description. A trigram or full-text index
-- would be better; this is an MVP catalog of a few dozen rows and a GIN index
-- on 40 rows is a slower way to do a sequential scan.
CREATE INDEX products_name_idx ON products (lower(name));

COMMENT ON TABLE products IS
  'Hand-seeded catalog. `shelf` is a search label only - compliance category '
  'comes from the MERCHANT MCC, so relabelling a product cannot dodge a rule.';

COMMENT ON COLUMN products.description IS
  'Bounded free text. Read by a language model, so treated as untrusted input: '
  'see the prompt-injection tests in Phase 7.';
