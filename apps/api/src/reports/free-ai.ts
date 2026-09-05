/**
 * FREE-AI control coverage.
 *
 * Runs every control's own verification query and reports how many have
 * evidence RIGHT NOW. A control whose query returns zero is a GAP, never a
 * pass - the same fail-closed instinct as the voucher, the checkpoint secret
 * and the webhook secret. Silence must not read as success.
 */
import type pg from 'pg';
import { ALL_CONTROLS, FREE_AI_CAVEAT, PILLARS, SUTRAS, type ControlDefinition } from './controls.js';

export type ControlStatus = 'covered' | 'no_evidence' | 'not_implemented' | 'error';

export interface ControlResult {
  readonly id: string;
  readonly title: string;
  readonly description: string;
  readonly sutra: string;
  readonly pillar: string;
  readonly status: ControlStatus;
  readonly evidenceCount: number;
  readonly evidenceLabel: string;
  readonly evidenceSample: string | null;
  readonly limitation: string | null;
  /** Present only when the control has no evidence. Says what is missing. */
  readonly gap: string | null;
}

export interface CoverageReport {
  readonly kind: 'free_ai_coverage';
  readonly generatedAt: string;
  readonly periodStart: string;
  readonly periodEnd: string;
  /** "20/26". A ratio, deliberately not a percentage. */
  readonly coverage: string;
  readonly controlsCovered: number;
  readonly controlsTotal: number;
  /** Controls in scope that we have deliberately NOT built. */
  readonly notImplemented: number;
  readonly bySutra: readonly { sutra: string; covered: number; total: number }[];
  readonly byPillar: readonly { pillar: string; covered: number; total: number }[];
  readonly controls: readonly ControlResult[];
  readonly gaps: readonly string[];
  /** Every stated limitation, gathered so none can be quietly skipped. */
  readonly limitations: readonly string[];
  readonly caveat: string;
}

/** Exported so the ERROR path can be tested with a deliberately broken query. */
export async function evaluateControl(
  client: pg.PoolClient | pg.Pool,
  control: ControlDefinition,
): Promise<ControlResult> {
  const base = {
    id: control.id, title: control.title, description: control.description,
    sutra: control.sutra, pillar: control.pillar,
    evidenceLabel: control.evidenceLabel, limitation: control.limitation,
  };

  // A control we have deliberately not built. No query is run and none is
  // invented: fabricating one designed to return zero would be theatre.
  if (control.notImplemented !== undefined) {
    return {
      ...base,
      status: 'not_implemented',
      evidenceCount: 0,
      evidenceSample: null,
      gap: `NOT IMPLEMENTED. ${control.notImplemented.reason} ` +
           `(planned: ${control.notImplemented.plannedIn})`,
    };
  }

  try {
    const result = await client.query<{ count: string; sample: string | null }>(
      control.evidenceQuery,
    );
    const count = Number(result.rows[0]?.count ?? 0);

    return {
      ...base,
      status: count > 0 ? 'covered' : 'no_evidence',
      evidenceCount: count,
      evidenceSample: result.rows[0]?.sample ?? null,
      gap: count > 0
        ? null
        : `No evidence found: ${control.evidenceLabel} returned zero rows.`,
    };
  } catch (error) {
    // A query that FAILS is not a covered control. It is more alarming than an
    // empty one - it means the thing we thought we were measuring no longer
    // exists in the shape we assumed.
    return {
      ...base,
      status: 'error',
      evidenceCount: 0,
      evidenceSample: null,
      gap: `Verification query failed: ${(error as Error).message}. The control ` +
           `cannot be evidenced and is NOT counted as covered.`,
    };
  }
}

export interface CoverageOptions {
  readonly periodStart?: Date;
  readonly periodEnd?: Date;
  readonly now?: Date;
}

export async function buildCoverageReport(
  client: pg.PoolClient | pg.Pool,
  options: CoverageOptions = {},
): Promise<CoverageReport> {
  const now = options.now ?? new Date();
  const periodEnd = options.periodEnd ?? now;
  const periodStart =
    options.periodStart ?? new Date(periodEnd.getTime() - 30 * 24 * 60 * 60 * 1000);

  // Sequential rather than parallel. These are cheap aggregates, and a
  // predictable single connection is worth more here than a few milliseconds:
  // twenty concurrent queries on a small pool is a self-inflicted stall.
  const controls: ControlResult[] = [];
  for (const control of ALL_CONTROLS) {
    controls.push(await evaluateControl(client, control));
  }

  const covered = controls.filter((control) => control.status === 'covered');

  const bySutra = SUTRAS.map((sutra) => ({
    sutra,
    covered: covered.filter((control) => control.sutra === sutra).length,
    total: controls.filter((control) => control.sutra === sutra).length,
  })).filter((row) => row.total > 0);

  const byPillar = PILLARS.map((pillar) => ({
    pillar,
    covered: covered.filter((control) => control.pillar === pillar).length,
    total: controls.filter((control) => control.pillar === pillar).length,
  })).filter((row) => row.total > 0);

  return {
    kind: 'free_ai_coverage',
    generatedAt: now.toISOString(),
    periodStart: periodStart.toISOString(),
    periodEnd: periodEnd.toISOString(),
    // A RATIO, not a percentage. "18/20" invites the question "which two?" -
    // which is the question a compliance officer should be asking. "90%"
    // invites nothing.
    coverage: `${covered.length}/${controls.length}`,
    notImplemented: controls.filter((control) => control.status === 'not_implemented').length,
    controlsCovered: covered.length,
    controlsTotal: controls.length,
    bySutra,
    byPillar,
    controls,
    gaps: controls
      .filter((control) => control.gap !== null)
      .map((control) => `${control.id} ${control.title}: ${control.gap!}`),
    limitations: controls
      .filter((control) => control.limitation !== null)
      .map((control) => `${control.id}: ${control.limitation!}`),
    caveat: FREE_AI_CAVEAT,
  };
}
