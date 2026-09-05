-- ===========================================================================
-- 0010_reports.sql - generated compliance artefacts
--
-- A report is EVIDENCE ABOUT OUR OWN PROCESS: who asked for it, when, over what
-- data, and what it said. So it is stored and append-only like everything else
-- in the evidence path.
--
-- THE MOST IMPORTANT COLUMN IN THIS FILE IS `status`, AND ITS CHECK.
--
-- An STR (Suspicious Transaction Report) is a LEGAL FILING made through
-- FIU-IND's FINnet by REGISTERED REPORTING ENTITIES. We are not one, we have no
-- FINnet access, and we have no authorisation. The research claims the system
-- can "auto-file an STR with FIU-IND"; it cannot, and neither can this table -
-- 'filed' is not an allowed value, so no code path can ever set it.
--
-- The honest workflow ends one step earlier:
--   detection -> candidate -> DRAFT -> human review -> READY FOR FILING
--
-- IMMUTABLE ONCE APPLIED.
-- ===========================================================================

CREATE TABLE compliance_reports (
  id              TEXT        PRIMARY KEY,

  kind            TEXT        NOT NULL,

  -- The period the report covers. A compliance artefact without a period is
  -- uninterpretable six months later.
  period_start    TIMESTAMPTZ NOT NULL,
  period_end      TIMESTAMPTZ NOT NULL,

  -- The computed body, exactly as it was returned. Stored rather than
  -- recomputed on demand: re-running the query next month gives a DIFFERENT
  -- answer, because the data has moved. A report is a statement about a moment.
  body            JSONB       NOT NULL,

  -- SHA-256 over the canonical serialisation of `body`, so a stored report can
  -- be shown to be the one that was generated. Same scheme as the audit trail.
  body_hash       TEXT        NOT NULL,

  -- DRAFT is the ONLY entry state, and 'filed' does not exist. See above.
  status          TEXT        NOT NULL DEFAULT 'DRAFT',

  -- Human review. NOT nullable-by-convention: the CHECK below makes an
  -- unreviewed report unable to claim it was reviewed.
  reviewed_by     TEXT,
  reviewed_at     TIMESTAMPTZ,
  review_note     TEXT,

  generated_by    TEXT        NOT NULL,
  generated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT compliance_reports_id_format
    CHECK (id ~ '^rpt_[a-z0-9_]{2,40}$'),

  CONSTRAINT compliance_reports_kind_valid
    CHECK (kind IN ('free_ai_coverage', 'str_draft', 'dpdp_register')),

  -- 'filed' is deliberately absent. Adding it would require a migration and
  -- therefore a review, which is exactly the friction such a change deserves.
  CONSTRAINT compliance_reports_status_valid
    CHECK (status IN ('DRAFT', 'UNDER_REVIEW', 'READY_FOR_FILING', 'REJECTED')),

  -- A reviewed report must say WHO reviewed it and WHEN. A review with no
  -- reviewer is not a review.
  CONSTRAINT compliance_reports_review_complete
    CHECK (
      status IN ('DRAFT')
      OR (reviewed_by IS NOT NULL AND reviewed_at IS NOT NULL)
    ),

  -- A rejection must say why.
  CONSTRAINT compliance_reports_rejection_explained
    CHECK (status <> 'REJECTED' OR (review_note IS NOT NULL AND length(trim(review_note)) > 0)),

  CONSTRAINT compliance_reports_period_ordered
    CHECK (period_end > period_start),

  CONSTRAINT compliance_reports_body_hash_format
    CHECK (body_hash ~ '^[0-9a-f]{64}$'),

  CONSTRAINT compliance_reports_body_is_object
    CHECK (jsonb_typeof(body) = 'object'),

  CONSTRAINT compliance_reports_generated_by_not_blank
    CHECK (length(trim(generated_by)) > 0)
);

-- Review is a real lifecycle, so UPDATE is permitted - but only along it.
CREATE FUNCTION compliance_reports_guard_transition() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  allowed TEXT[];
BEGIN
  -- IMMUTABILITY FIRST, and the ordering is deliberate - the same lesson as
  -- payments_guard_transition in migration 0004, where an early return made a
  -- security check unreachable in precisely the case it existed for.
  --
  -- The BODY of a report is what a reviewer approved. Editing it after review
  -- would let an approved report say something nobody approved.
  IF NEW.body_hash <> OLD.body_hash OR NEW.kind <> OLD.kind THEN
    RAISE EXCEPTION 'a report body is immutable once generated'
      USING ERRCODE = 'ATL02';
  END IF;

  IF NEW.status = OLD.status THEN
    RETURN NEW;
  END IF;

  allowed := CASE OLD.status
    WHEN 'DRAFT'            THEN ARRAY['UNDER_REVIEW', 'REJECTED']
    WHEN 'UNDER_REVIEW'     THEN ARRAY['READY_FOR_FILING', 'REJECTED']
    WHEN 'READY_FOR_FILING' THEN ARRAY[]::TEXT[]   -- terminal for us: a human
                                                   -- files it outside this system
    WHEN 'REJECTED'         THEN ARRAY[]::TEXT[]
    ELSE ARRAY[]::TEXT[]
  END;

  IF NOT (NEW.status = ANY (allowed)) THEN
    RAISE EXCEPTION 'illegal report transition: % -> %', OLD.status, NEW.status
      USING ERRCODE = 'ATL02',
            HINT = 'DRAFT->UNDER_REVIEW|REJECTED, UNDER_REVIEW->READY_FOR_FILING|REJECTED.';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER compliance_reports_guard_transition
  BEFORE UPDATE ON compliance_reports
  FOR EACH ROW EXECUTE FUNCTION compliance_reports_guard_transition();

CREATE TRIGGER compliance_reports_no_delete
  BEFORE DELETE ON compliance_reports
  FOR EACH ROW EXECUTE FUNCTION reject_mutation();

CREATE TRIGGER compliance_reports_no_truncate
  BEFORE TRUNCATE ON compliance_reports
  FOR EACH STATEMENT EXECUTE FUNCTION reject_truncate();

CREATE INDEX compliance_reports_by_kind_idx
  ON compliance_reports (kind, generated_at DESC);

-- The review queue: what a compliance officer has to look at.
CREATE INDEX compliance_reports_pending_idx
  ON compliance_reports (generated_at DESC)
  WHERE status IN ('DRAFT', 'UNDER_REVIEW');

GRANT UPDATE ON compliance_reports TO atl_app;

COMMENT ON TABLE compliance_reports IS
  'Generated compliance artefacts. Body is immutable; status follows a review '
  'lifecycle that STOPS at READY_FOR_FILING. There is no "filed" state: FIU-IND '
  'filing runs through FINnet by registered reporting entities, which we are not.';
