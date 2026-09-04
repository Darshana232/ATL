/**
 * Mandate data access.
 *
 * The ONLY module that knows SQL for the mandate aggregate. Everything above
 * it receives domain objects, so changing a query, adding an index or altering
 * the schema touches this file and nothing else.
 *
 * Functions take a `client` rather than a pool, so the caller controls the
 * transaction. That is what lets a route write a mandate AND its audit event
 * atomically - an audit event describing a mandate that was never created, or
 * a mandate with no audit event, is worse than either alone.
 */
import { randomBytes } from 'node:crypto';
import type pg from 'pg';
import {
  createMandateTerms,
  type Mandate,
  type MandateStatus,
  type MandateTerms,
  type MandateVersion,
  type MandateWithVersion,
} from '../domain/mandate.js';

export function newMandateId(): string {
  // 10 random bytes -> 20 lowercase hex chars, satisfying
  // CHECK (id ~ '^mnd_[a-z0-9_]{2,40}$').
  return `mnd_${randomBytes(10).toString('hex')}`;
}

/* ------------------------------------------------------------------------ */
/* Row shapes and mapping                                                   */
/* ------------------------------------------------------------------------ */

interface VersionRow {
  mandate_id: string;
  version: number;
  per_txn_limit_paise: number;
  window_limit_paise: number;
  window_kind: string;
  max_txn_per_hour: number;
  blocked_mccs: string[];
  timezone: string;
  window_start_hour: number;
  window_end_hour: number;
  allowed_weekdays: string[];
  valid_from: Date;
  valid_to: Date;
  payment_methods: string[];
  afa_exemption_threshold_paise: number;
  created_at: Date;
  created_by: string;
  change_reason: string | null;
  consent_ref: string;
  consent_at: Date;
  merchant_ids: string[] | null;
}

interface MandateRow {
  id: string;
  user_id: string;
  agent_id: string;
  label: string;
  status: string;
  revoked_at: Date | null;
  revoked_by: string | null;
  revoked_reason: string | null;
  created_at: Date;
}

function toTerms(row: VersionRow): MandateTerms {
  // Rebuilt through the domain constructor rather than cast into shape. Slower
  // by a microsecond and worth it: a row that somehow violates an invariant
  // fails HERE, loudly, instead of flowing into the policy engine as a
  // structurally-valid but semantically-broken value.
  return createMandateTerms({
    perTxnLimitPaise: row.per_txn_limit_paise,
    windowLimitPaise: row.window_limit_paise,
    windowKind: row.window_kind,
    maxTxnPerHour: row.max_txn_per_hour,
    blockedMccs: row.blocked_mccs,
    timezone: row.timezone,
    windowStartHour: row.window_start_hour,
    windowEndHour: row.window_end_hour,
    allowedWeekdays: row.allowed_weekdays,
    validFrom: row.valid_from,
    validTo: row.valid_to,
    paymentMethods: row.payment_methods,
    afaExemptionThresholdPaise: row.afa_exemption_threshold_paise,
  });
}

function toVersion(row: VersionRow): MandateVersion {
  return {
    mandateId: row.mandate_id,
    version: row.version,
    terms: toTerms(row),
    // COALESCE in SQL already turns "no rows" into an empty array, but the
    // null-guard here is deliberate belt-and-braces: an empty allowlist means
    // NO merchant is permitted, and reading it as null (then as "unset", then
    // as "all") would invert a deny-by-default rule into allow-by-default.
    merchantAllowlist: row.merchant_ids ?? [],
    createdAt: row.created_at,
    createdBy: row.created_by,
    changeReason: row.change_reason,
    consentRef: row.consent_ref,
    consentAt: row.consent_at,
  };
}

function toMandate(row: MandateRow): Mandate {
  return {
    id: row.id,
    userId: row.user_id,
    agentId: row.agent_id,
    label: row.label,
    status: row.status as MandateStatus,
    revokedAt: row.revoked_at,
    revokedBy: row.revoked_by,
    revokedReason: row.revoked_reason,
    createdAt: row.created_at,
  };
}

/** Columns selected from mandate_versions, plus the aggregated allowlist. */
const VERSION_COLUMNS = `
  v.mandate_id, v.version, v.per_txn_limit_paise, v.window_limit_paise,
  v.window_kind, v.max_txn_per_hour,
  -- CAST REQUIRED. blocked_mccs is mcc_code[] - an array of a custom DOMAIN -
  -- and node-postgres has no parser for that OID, so it returns the raw
  -- Postgres literal "{5921,7995}" as a STRING rather than an array. Iterating
  -- it then yields characters, not codes.
  --
  -- We cast instead of registering a parser for the domain's OID because that
  -- OID is assigned at CREATE DOMAIN time and therefore DIFFERS PER DATABASE:
  -- a hardcoded parser would work locally and break on a fresh deployment.
  v.blocked_mccs::text[] AS blocked_mccs,
  v.timezone,
  v.window_start_hour, v.window_end_hour, v.allowed_weekdays,
  v.valid_from, v.valid_to, v.payment_methods,
  v.afa_exemption_threshold_paise, v.created_at, v.created_by,
  v.change_reason, v.consent_ref, v.consent_at
`;

/** LEFT JOIN LATERAL so a version with no allowlist still returns a row. */
const ALLOWLIST_LATERAL = `
  LEFT JOIN LATERAL (
    SELECT array_agg(mvm.merchant_id ORDER BY mvm.merchant_id) AS merchant_ids
      FROM mandate_version_merchants mvm
     WHERE mvm.mandate_id = v.mandate_id AND mvm.version = v.version
  ) allow ON true
`;

/* ------------------------------------------------------------------------ */
/* Reads                                                                    */
/* ------------------------------------------------------------------------ */

/**
 * Load a mandate with the version CURRENTLY in force, plus its allowlist.
 *
 * ONE QUERY. This runs on every authorization in Phase 4, so three round trips
 * (mandate, then latest version, then allowlist) would be an N+1 on the
 * hottest path in the system.
 *
 * JOIN LATERAL is what makes it one query: the subquery may reference `m.id`
 * from the row to its left, so "the newest version OF THIS mandate" is
 * expressible inline. A plain subquery cannot see the outer row that way.
 *
 * The current version is derived as MAX(version) rather than stored (see
 * migration 0003): a stored pointer could drift, and ORDER BY version DESC
 * LIMIT 1 rides the (mandate_id, version DESC) index.
 */
export async function loadForAuthorization(
  client: pg.PoolClient | pg.Pool,
  mandateId: string,
): Promise<MandateWithVersion | null> {
  const result = await client.query<MandateRow & VersionRow>(
    `SELECT
        m.id, m.user_id, m.agent_id, m.label, m.status,
        m.revoked_at, m.revoked_by, m.revoked_reason, m.created_at AS mandate_created_at,
        ${VERSION_COLUMNS},
        COALESCE(allow.merchant_ids, ARRAY[]::text[]) AS merchant_ids
       FROM mandates m
       JOIN LATERAL (
         SELECT * FROM mandate_versions mv
          WHERE mv.mandate_id = m.id
          ORDER BY mv.version DESC
          LIMIT 1
       ) v ON true
       ${ALLOWLIST_LATERAL}
      WHERE m.id = $1`,
    [mandateId],
  );

  const row = result.rows[0];
  if (row === undefined) return null;

  // `created_at` appears on both tables; the mandate's was aliased to avoid
  // the version's silently winning.
  const mandateRow = row as unknown as MandateRow & { mandate_created_at: Date };

  return {
    mandate: toMandate({ ...mandateRow, created_at: mandateRow.mandate_created_at }),
    version: toVersion(row),
  };
}

/**
 * Load one SPECIFIC historical version.
 *
 * This is the read the entire two-table design exists to make possible: a
 * decision made under version 1 must remain explainable against version 1's
 * numbers, even after version 3 raised the limit.
 */
export async function loadVersion(
  client: pg.PoolClient | pg.Pool,
  mandateId: string,
  version: number,
): Promise<MandateVersion | null> {
  const result = await client.query<VersionRow>(
    `SELECT ${VERSION_COLUMNS},
            COALESCE(allow.merchant_ids, ARRAY[]::text[]) AS merchant_ids
       FROM mandate_versions v
       ${ALLOWLIST_LATERAL}
      WHERE v.mandate_id = $1 AND v.version = $2`,
    [mandateId, version],
  );

  const row = result.rows[0];
  return row === undefined ? null : toVersion(row);
}

/** Full version history, oldest first. */
export async function listVersions(
  client: pg.PoolClient | pg.Pool,
  mandateId: string,
): Promise<MandateVersion[]> {
  const result = await client.query<VersionRow>(
    `SELECT ${VERSION_COLUMNS},
            COALESCE(allow.merchant_ids, ARRAY[]::text[]) AS merchant_ids
       FROM mandate_versions v
       ${ALLOWLIST_LATERAL}
      WHERE v.mandate_id = $1
      ORDER BY v.version`,
    [mandateId],
  );

  return result.rows.map(toVersion);
}

/* ------------------------------------------------------------------------ */
/* Writes - all require a transaction the caller owns                       */
/* ------------------------------------------------------------------------ */

export interface InsertVersionParams {
  readonly mandateId: string;
  readonly version: number;
  readonly terms: MandateTerms;
  readonly merchantIds: readonly string[];
  readonly createdBy: string;
  readonly changeReason: string | null;
  readonly consentRef: string;
  readonly consentAt: Date;
}

/** Insert one version and its allowlist. Append-only: never an update. */
export async function insertVersion(
  txClient: pg.PoolClient,
  params: InsertVersionParams,
): Promise<void> {
  const { terms } = params;

  await txClient.query(
    `INSERT INTO mandate_versions
       (mandate_id, version, per_txn_limit_paise, window_limit_paise, window_kind,
        max_txn_per_hour, blocked_mccs, timezone, window_start_hour, window_end_hour,
        allowed_weekdays, valid_from, valid_to, payment_methods,
        afa_exemption_threshold_paise, created_by, change_reason, consent_ref, consent_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7::mcc_code[],$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19)`,
    [
      params.mandateId,
      params.version,
      terms.perTxnLimitPaise,
      terms.windowLimitPaise,
      terms.windowKind,
      terms.maxTxnPerHour,
      terms.blockedMccs,
      terms.timezone,
      terms.windowStartHour,
      terms.windowEndHour,
      terms.allowedWeekdays,
      terms.validFrom.toISOString(),
      terms.validTo.toISOString(),
      terms.paymentMethods,
      terms.afaExemptionThresholdPaise,
      params.createdBy,
      params.changeReason,
      params.consentRef,
      params.consentAt.toISOString(),
    ],
  );

  for (const merchantId of params.merchantIds) {
    await txClient.query(
      `INSERT INTO mandate_version_merchants (mandate_id, version, merchant_id)
       VALUES ($1,$2,$3)`,
      [params.mandateId, params.version, merchantId],
    );
  }
}

export interface CreateMandateParams extends Omit<InsertVersionParams, 'version'> {
  readonly userId: string;
  readonly agentId: string;
  readonly label: string;
}

/** Create a mandate and its version 1 together. */
export async function insertMandate(
  txClient: pg.PoolClient,
  params: CreateMandateParams,
): Promise<void> {
  await txClient.query(
    `INSERT INTO mandates (id, user_id, agent_id, label) VALUES ($1,$2,$3,$4)`,
    [params.mandateId, params.userId, params.agentId, params.label],
  );

  await insertVersion(txClient, { ...params, version: 1 });
}

/**
 * The next version number for a mandate.
 *
 * Takes a row lock on the mandate first, so two concurrent "add a version"
 * requests cannot both compute the same next number. Without it they would
 * both try version N+1 and one would hit the primary key - correct, but a
 * confusing 500 rather than an orderly wait.
 */
export async function nextVersionNumber(
  txClient: pg.PoolClient,
  mandateId: string,
): Promise<number> {
  await txClient.query(`SELECT 1 FROM mandates WHERE id = $1 FOR UPDATE`, [mandateId]);

  const result = await txClient.query<{ next: number }>(
    `SELECT COALESCE(MAX(version), 0) + 1 AS next FROM mandate_versions WHERE mandate_id = $1`,
    [mandateId],
  );

  return result.rows[0]?.next ?? 1;
}

export interface RevokeParams {
  readonly mandateId: string;
  readonly revokedBy: string;
  readonly revokedReason: string;
}

/**
 * Revoke a mandate. Returns false if it was not active.
 *
 * `AND status = 'active'` makes this idempotent-safe: a second revocation
 * affects no rows and returns false, rather than being refused by the
 * lifecycle trigger with a 500. Revocation is terminal by design (0003).
 */
export async function revokeMandate(
  txClient: pg.PoolClient,
  params: RevokeParams,
): Promise<boolean> {
  const result = await txClient.query(
    `UPDATE mandates
        SET status = 'revoked', revoked_at = now(), revoked_by = $2, revoked_reason = $3
      WHERE id = $1 AND status = 'active'`,
    [params.mandateId, params.revokedBy, params.revokedReason],
  );

  return (result.rowCount ?? 0) > 0;
}
