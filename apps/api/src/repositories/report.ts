/**
 * Report persistence.
 *
 * A report is stored rather than recomputed on demand, because re-running the
 * query next month gives a DIFFERENT answer - the data has moved. A compliance
 * report is a statement about a moment, and it has to keep saying the same
 * thing when somebody opens it in six months.
 */
import { randomBytes } from 'node:crypto';
import type pg from 'pg';
import { hashCanonical, type CanonicalValue } from '../audit/canonical.js';

export const newReportId = (): string => `rpt_${randomBytes(10).toString('hex')}`;

export type ReportKind = 'free_ai_coverage' | 'str_draft' | 'dpdp_register';
export type ReportStatus = 'DRAFT' | 'UNDER_REVIEW' | 'READY_FOR_FILING' | 'REJECTED';

export interface StoredReport {
  readonly id: string;
  readonly kind: ReportKind;
  readonly periodStart: Date;
  readonly periodEnd: Date;
  readonly body: unknown;
  readonly bodyHash: string;
  readonly status: ReportStatus;
  readonly reviewedBy: string | null;
  readonly reviewedAt: Date | null;
  readonly reviewNote: string | null;
  readonly generatedBy: string;
  readonly generatedAt: Date;
}

interface RawReport {
  id: string; kind: string; period_start: Date; period_end: Date;
  body: unknown; body_hash: string; status: string;
  reviewed_by: string | null; reviewed_at: Date | null; review_note: string | null;
  generated_by: string; generated_at: Date;
}

function toReport(row: RawReport): StoredReport {
  return {
    id: row.id, kind: row.kind as ReportKind,
    periodStart: row.period_start, periodEnd: row.period_end,
    body: row.body, bodyHash: row.body_hash, status: row.status as ReportStatus,
    reviewedBy: row.reviewed_by, reviewedAt: row.reviewed_at,
    reviewNote: row.review_note,
    generatedBy: row.generated_by, generatedAt: row.generated_at,
  };
}

const COLUMNS = `
  id, kind, period_start, period_end, body, body_hash, status,
  reviewed_by, reviewed_at, review_note, generated_by, generated_at
`;

/**
 * The body hash uses the SAME canonical serialisation as the audit chain.
 *
 * One definition of "how we hash a structure", reused. Two would eventually
 * disagree, and a disagreement in a compliance artefact looks like tampering -
 * exactly the argument made for `computeEventHash` in Phase 6.
 */
export function hashReportBody(body: unknown): string {
  return hashCanonical(body as CanonicalValue);
}

export async function insertReport(
  txClient: pg.PoolClient,
  params: {
    readonly id: string;
    readonly kind: ReportKind;
    readonly periodStart: Date;
    readonly periodEnd: Date;
    readonly body: unknown;
    readonly generatedBy: string;
  },
): Promise<string> {
  const bodyHash = hashReportBody(params.body);

  await txClient.query(
    `INSERT INTO compliance_reports
       (id, kind, period_start, period_end, body, body_hash, generated_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7)`,
    [
      params.id, params.kind, params.periodStart, params.periodEnd,
      JSON.stringify(params.body), bodyHash, params.generatedBy,
    ],
  );

  return bodyHash;
}

export async function findReport(
  client: pg.PoolClient | pg.Pool,
  id: string,
): Promise<StoredReport | null> {
  const result = await client.query<RawReport>(
    `SELECT ${COLUMNS} FROM compliance_reports WHERE id = $1`, [id],
  );
  const row = result.rows[0];
  return row === undefined ? null : toReport(row);
}

export async function listReports(
  client: pg.PoolClient | pg.Pool,
  options: { kind?: ReportKind; limit?: number } = {},
): Promise<StoredReport[]> {
  const result = await client.query<RawReport>(
    `SELECT ${COLUMNS} FROM compliance_reports
      WHERE ($1::text IS NULL OR kind = $1)
      ORDER BY generated_at DESC
      LIMIT $2`,
    [options.kind ?? null, Math.min(Math.max(options.limit ?? 25, 1), 100)],
  );

  return result.rows.map(toReport);
}

/**
 * Advance a report through review.
 *
 * The legal transitions are enforced by `compliance_reports_guard_transition`
 * in migration 0010, not here - and there is no 'filed' state to advance to.
 */
export async function reviewReport(
  client: pg.PoolClient | pg.Pool,
  id: string,
  params: { status: ReportStatus; reviewedBy: string; note: string | null },
): Promise<void> {
  await client.query(
    `UPDATE compliance_reports
        SET status = $2, reviewed_by = $3, reviewed_at = now(), review_note = $4
      WHERE id = $1`,
    [id, params.status, params.reviewedBy, params.note?.slice(0, 2000) ?? null],
  );
}
