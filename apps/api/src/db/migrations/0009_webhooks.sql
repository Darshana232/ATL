-- ===========================================================================
-- 0009_webhooks.sql - the record of what a payment provider told us
--
-- WHY THIS TABLE EXISTS AT ALL: webhooks are AT-LEAST-ONCE.
--
-- Every provider retries on any non-2xx response, and on a timeout - including
-- a timeout that happened AFTER we already processed the event successfully.
-- So the same "payment.captured" notification will arrive twice, and a handler
-- that is not idempotent will capture twice.
--
-- The defence is not application logic. It is this UNIQUE constraint: the
-- provider's own event id can be recorded once, and the second attempt loses
-- at INSERT. Exactly the same pattern as authorization idempotency and voucher
-- redemption - three different problems, one mechanism, because the mechanism
-- is the only one that wins a race.
--
-- APPEND-ONLY: what a provider told us and when is a historical fact. The
-- PROCESSING outcome is recorded on the same row at insert time, so there is
-- no lifecycle to update.
--
-- IMMUTABLE ONCE APPLIED.
-- ===========================================================================

CREATE TABLE webhook_events (
  id                    TEXT        PRIMARY KEY,

  provider              TEXT        NOT NULL,

  -- The provider's identifier for this delivery. THE IDEMPOTENCY KEY.
  --
  -- Razorpay sends `x-razorpay-event-id`. When a provider sends no such header
  -- we synthesise one from a hash of the raw body, which is weaker (a genuinely
  -- identical repeat event is indistinguishable from a redelivery) and is
  -- recorded as such in `event_id_source`.
  provider_event_id     TEXT        NOT NULL,
  event_id_source       TEXT        NOT NULL DEFAULT 'header',

  event_type            TEXT        NOT NULL,

  -- Whether the HMAC over the RAW BODY verified. Recorded even when false: a
  -- forged webhook attempt is exactly the kind of event a security review wants
  -- to count, and unlike a failed request signature this row has no foreign
  -- keys to satisfy, so it CAN be recorded (contrast PHASE_05 section 12).
  signature_verified    BOOLEAN     NOT NULL,

  -- What we did about it. 'ignored' covers events we do not handle, which is
  -- most of them - a provider sends far more event types than we care about.
  outcome               TEXT        NOT NULL,
  outcome_detail        TEXT,

  -- Our payment, when we could match one. NULL for an unmatched or forged
  -- event, which is why this is nullable rather than NOT NULL.
  payment_id            TEXT        REFERENCES payments (id) ON DELETE RESTRICT,

  -- The body as received. JSONB rather than TEXT because operators query it
  -- during reconciliation ("what did they actually send us?").
  payload               JSONB       NOT NULL,

  -- SHA-256 of the RAW bytes we verified against. Lets us prove later that the
  -- stored JSONB corresponds to the bytes that were signed - JSONB normalises
  -- key order and whitespace, so it is not byte-identical to what arrived.
  raw_body_sha256       TEXT        NOT NULL,

  received_at           TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT webhook_events_id_format
    CHECK (id ~ '^whk_[a-z0-9_]{2,40}$'),

  CONSTRAINT webhook_events_provider_valid
    CHECK (provider IN ('mock_upi', 'razorpay_test')),

  CONSTRAINT webhook_events_event_id_source_valid
    CHECK (event_id_source IN ('header', 'body_hash')),

  CONSTRAINT webhook_events_outcome_valid
    CHECK (outcome IN ('captured', 'failed', 'ignored', 'rejected', 'unmatched', 'duplicate')),

  CONSTRAINT webhook_events_raw_hash_format
    CHECK (raw_body_sha256 ~ '^[0-9a-f]{64}$'),

  CONSTRAINT webhook_events_payload_is_object
    CHECK (jsonb_typeof(payload) = 'object'),

  -- THE LINE THAT PREVENTS DOUBLE CAPTURE. Scoped per provider, because two
  -- providers may legitimately use the same id space.
  CONSTRAINT webhook_events_once_per_provider
    UNIQUE (provider, provider_event_id)
);

CREATE TRIGGER webhook_events_append_only
  BEFORE UPDATE OR DELETE ON webhook_events
  FOR EACH ROW EXECUTE FUNCTION reject_mutation();

CREATE TRIGGER webhook_events_no_truncate
  BEFORE TRUNCATE ON webhook_events
  FOR EACH STATEMENT EXECUTE FUNCTION reject_truncate();

-- Reconciliation: "everything this provider told us about this payment".
CREATE INDEX webhook_events_by_payment_idx
  ON webhook_events (payment_id, received_at DESC) WHERE payment_id IS NOT NULL;

-- Security review: forged or unmatched deliveries. Partial, because they should
-- be rare - a small index over the interesting rows.
CREATE INDEX webhook_events_suspicious_idx
  ON webhook_events (provider, received_at DESC)
  WHERE signature_verified = false OR outcome IN ('unmatched', 'rejected');

REVOKE UPDATE, DELETE ON webhook_events FROM atl_app;

COMMENT ON TABLE webhook_events IS
  'Provider callbacks. Append-only. UNIQUE (provider, provider_event_id) is '
  'what makes at-least-once delivery safe: a redelivered event loses at INSERT '
  'rather than capturing a payment twice.';
