-- ===========================================================================
-- 0006_consent.sql - every mandate version must carry recorded consent
--
-- DECISION: every new version, including version 1, requires a consent
-- reference and a consent timestamp. Enforced as NOT NULL, so the database
-- refuses a version without them.
--
-- The rejected alternative was to gate only "widening" changes (raise a limit,
-- add a merchant, unblock a category) and let narrowing ones through, since
-- narrowing cannot harm the user. That needs a classifier function deciding
-- whether a diff increases authority - and that function then sits IN THE
-- SECURITY PATH, where a bug is a silent authority increase. NOT NULL has no
-- moving parts: there is no code path that can skip consent because there is
-- no code involved.
--
-- Cost accepted: friction on purely protective changes. A parent lowering a
-- child's limit still re-confirms.
--
-- ---------------------------------------------------------------------------
-- WHY THIS MIGRATION IS NOT THE TEXTBOOK THREE-STEP
--
-- Adding a NOT NULL column with no default to a table that already has rows is
-- impossible. The standard workaround is:
--     1. ADD COLUMN ... NULL
--     2. UPDATE ... SET ... (backfill)
--     3. ALTER COLUMN ... SET NOT NULL
--
-- Step 2 is BLOCKED HERE by our own append-only trigger on mandate_versions.
-- We deliberately made this table unbackfillable, and this is the first time
-- that bites.
--
-- Options considered:
--   (a) ADD COLUMN ... NOT NULL DEFAULT 'legacy'
--       Works without a table rewrite in PostgreSQL 11+, but it would stamp a
--       FABRICATED consent reference onto historical rows. Rejected outright:
--       inventing evidence is the one thing this project must never do.
--   (b) Nullable columns plus a grandfather CHECK:
--         CHECK (created_at < '<cutover>' OR consent_ref IS NOT NULL)
--       Honest - pre-existing rows are visibly exempt rather than silently
--       backfilled. THIS IS WHAT WE WOULD DO AGAINST REAL DATA.
--   (c) Drop and re-migrate, because the only existing rows are regenerable
--       seed fixtures.
--
-- We take (c): the 8 existing versions are seed data, and a clean chain of
-- migrations from an empty database is worth verifying anyway. Recording (b)
-- because the next time this happens the rows may be real.
-- ===========================================================================

ALTER TABLE mandate_versions
  ADD COLUMN consent_ref TEXT        NOT NULL,
  ADD COLUMN consent_at  TIMESTAMPTZ NOT NULL;

COMMENT ON COLUMN mandate_versions.consent_ref IS
  'Identifier of the consent record authorising these terms. In Phase 3 this is '
  'supplied by the API caller: the database enforces that a reference is '
  'RECORDED, not that a human agreed. A real consent flow needs the Phase 9 UI.';

COMMENT ON COLUMN mandate_versions.consent_at IS
  'When consent for these terms was obtained.';

-- An empty string would satisfy NOT NULL while meaning nothing.
ALTER TABLE mandate_versions
  ADD CONSTRAINT mandate_versions_consent_ref_not_blank
    CHECK (length(trim(consent_ref)) > 0);

-- Consent cannot postdate the change it authorises. One minute of tolerance
-- for clock skew between whatever captured the consent and this database.
ALTER TABLE mandate_versions
  ADD CONSTRAINT mandate_versions_consent_not_after_creation
    CHECK (consent_at <= created_at + interval '1 minute');
