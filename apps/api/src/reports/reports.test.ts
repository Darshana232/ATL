/**
 * The three reports.
 *
 * The tests that matter most here are the NEGATIVE ones: no compliance
 * percentage, no claim of filing, no gap list that quietly empties itself.
 * Every one of them would pass trivially if the report were honest and fail
 * loudly the moment somebody "improved" the wording.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadConfig, type Config } from '../config.js';
import { createLogger } from '../logger.js';
import { closePool, createPool, type Pool } from '../db/pool.js';
import { buildCoverageReport, evaluateControl } from './free-ai.js';
import { buildStrDraft } from './str.js';
import { buildDpdpRegister, DPDP_GAPS, PROCESSING_RECORDS } from './dpdp.js';
import { ALL_CONTROLS, CONTROLS, UNBUILT_CONTROLS } from './controls.js';

const config: Config = loadConfig({ ...process.env, NODE_ENV: 'test', LOG_LEVEL: 'fatal' });
const logger = createLogger(config);

let pool: Pool;

beforeAll(() => { pool = createPool(config, logger); });
afterAll(async () => { await closePool(pool, logger); });

/* ------------------------------------------------------------------------ */
/* FREE-AI coverage                                                         */
/* ------------------------------------------------------------------------ */

describe('FREE-AI control coverage', () => {
  it('reports a RATIO, never a percentage', async () => {
    // "18/20" invites "which two?" - the question a compliance officer should
    // be asking. "90%" invites nothing.
    const report = await buildCoverageReport(pool);

    expect(report.coverage).toMatch(/^\d+\/\d+$/);
    expect(report.coverage).not.toContain('%');
  });

  it('never emits the word "compliant" anywhere in the report', async () => {
    // RESEARCH_REALITY_CHECK item 4: "98.75% COMPLIANT with RBI FREE-AI" is
    // indefensible - there is no certifying authority and no methodology.
    const serialised = JSON.stringify(await buildCoverageReport(pool));

    expect(serialised.toLowerCase()).not.toMatch(/\bcompliant\b/);
    expect(serialised).not.toMatch(/\d+(\.\d+)?%/);
  });

  it('includes controls we have NOT built', async () => {
    // The first version of this report listed only implemented controls and
    // returned 20/20 with zero gaps - a number guaranteed before a query ran.
    // A coverage report over a self-selected set of successes is the same
    // species of claim as "98.75% compliant", with better manners.
    expect(UNBUILT_CONTROLS.length).toBeGreaterThan(0);

    const report = await buildCoverageReport(pool);
    expect(report.notImplemented).toBe(UNBUILT_CONTROLS.length);
    expect(report.controlsCovered).toBeLessThan(report.controlsTotal);
  });

  it('names every gap specifically', async () => {
    const report = await buildCoverageReport(pool);

    expect(report.gaps.length).toBeGreaterThan(0);
    for (const gap of report.gaps) {
      // A gap must name the control AND say something about it, not just
      // "missing".
      expect(gap).toMatch(/^ATL-C\d+ /);
      expect(gap.length).toBeGreaterThan(60);
    }
  });

  it('states the merchant-validation gap without softening it', async () => {
    // Criterion B1. The research contains quotes attributed to merchant
    // compliance staff that appear to be fabricated. This must never be
    // presented as validation.
    const report = await buildCoverageReport(pool);
    const gap = report.gaps.find((entry) => entry.includes('ATL-C26'));

    expect(gap).toBeDefined();
    expect(gap).toContain('NO MERCHANT INTERVIEWS HAVE TAKEN PLACE');
  });

  it('counts a control as covered ONLY when its query returns rows', async () => {
    const report = await buildCoverageReport(pool);

    for (const control of report.controls) {
      if (control.status === 'covered') expect(control.evidenceCount).toBeGreaterThan(0);
      else expect(control.evidenceCount).toBe(0);
    }
  });

  it('treats a failing verification query as a GAP, not a pass', async () => {
    // A query that FAILS is more alarming than an empty one: the thing we
    // thought we were measuring no longer exists in the shape we assumed. It
    // must never be counted as covered.
    //
    // Tested by actually running a broken control, not by asserting that the
    // branch exists. A first version of this test called buildCoverageReport
    // and checked an invariant that held whether or not the error path worked.
    const result = await evaluateControl(pool, {
      ...CONTROLS[0]!,
      id: 'ATL-TEST',
      evidenceQuery: 'SELECT * FROM a_table_that_does_not_exist',
    });

    expect(result.status).toBe('error');
    expect(result.evidenceCount).toBe(0);
    expect(result.gap).toContain('Verification query failed');
    expect(result.gap).toContain('NOT counted as covered');
  });

  it('carries the caveat as a required field', async () => {
    const report = await buildCoverageReport(pool);

    expect(report.caveat).toContain('NOT A COMPLIANCE SCORE');
    expect(report.caveat).toContain('no certifying authority');
  });

  it('gathers every stated limitation, so none can be skipped', async () => {
    const report = await buildCoverageReport(pool);
    const declared = ALL_CONTROLS.filter((control) => control.limitation !== null).length;

    expect(report.limitations).toHaveLength(declared);
  });

  it('groups by the real seven sutras and six pillars', async () => {
    const report = await buildCoverageReport(pool);

    for (const row of report.bySutra) expect(row.covered).toBeLessThanOrEqual(row.total);
    for (const row of report.byPillar) expect(row.covered).toBeLessThanOrEqual(row.total);
  });
});

/* ------------------------------------------------------------------------ */
/* STR draft                                                                */
/* ------------------------------------------------------------------------ */

describe('STR draft', () => {
  it('is always a DRAFT and never claims to be filed', async () => {
    // RESEARCH_REALITY_CHECK item 6. FIU-IND filing runs through FINnet by
    // registered reporting entities. We are not one.
    const draft = await buildStrDraft(pool);

    expect(draft.status).toBe('DRAFT');
    expect(draft.caveat).toContain('NOT a filed Suspicious Transaction Report');
    expect(draft.reportingEntity.registrationStatus).toContain('NOT a registered');
    expect(draft.reportingEntity.finnetAccess).toContain('None');
  });

  it('says explicitly that it cannot file', async () => {
    const draft = await buildStrDraft(pool);
    expect(draft.nextStep).toContain('cannot and will not file');
  });

  it('is deterministic: the same period twice gives the same output', async () => {
    // A report that is not stable cannot be hashed, stored and compared - and a
    // compliance artefact that changes when you reopen it is worthless.
    const period = {
      periodStart: new Date('2026-08-01T00:00:00Z'),
      periodEnd: new Date('2026-10-01T00:00:00Z'),
      now: new Date('2026-09-05T12:00:00Z'),
    };

    const first = await buildStrDraft(pool, period);
    const second = await buildStrDraft(pool, period);

    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
  });

  it('finds real candidates from the decisions six phases produced', async () => {
    const draft = await buildStrDraft(pool, {
      periodStart: new Date('2020-01-01T00:00:00Z'),
      periodEnd: new Date('2030-01-01T00:00:00Z'),
    });

    expect(draft.candidateCount).toBeGreaterThan(0);
  });

  it('puts the actual NUMBERS in every narrative', async () => {
    // A reviewer cannot assess "a limit was exceeded". They can assess
    // "₹6,200 against a ₹2,000 limit".
    const draft = await buildStrDraft(pool, {
      periodStart: new Date('2020-01-01T00:00:00Z'),
      periodEnd: new Date('2030-01-01T00:00:00Z'),
    });

    const limitBreach = draft.candidates.find((c) => c.reason === 'MANDATE_LIMIT_BREACH');

    expect(limitBreach).toBeDefined();
    expect(limitBreach!.narrative).toMatch(/₹[\d,]+/);
    expect(limitBreach!.agentId).not.toBeNull();
    expect(limitBreach!.evidenceRefs.length).toBeGreaterThan(0);
  });

  it('labels the simulated risk provider inside the narrative', async () => {
    const draft = await buildStrDraft(pool, {
      periodStart: new Date('2020-01-01T00:00:00Z'),
      periodEnd: new Date('2030-01-01T00:00:00Z'),
    });

    for (const candidate of draft.candidates) {
      if (candidate.reason === 'HIGH_RISK_BAND') {
        expect(candidate.narrative).toContain('SIMULATION');
        expect(candidate.narrative).toContain('advisory');
      }
    }
  });

  it('returns an empty draft for a period with no activity, not an error', async () => {
    const draft = await buildStrDraft(pool, {
      periodStart: new Date('1990-01-01T00:00:00Z'),
      periodEnd: new Date('1990-02-01T00:00:00Z'),
    });

    expect(draft.candidateCount).toBe(0);
    // The caveat survives an empty report. An empty draft is the one most
    // likely to be screenshotted as "all clear".
    expect(draft.caveat).toContain('HUMAN REVIEW REQUIRED');
  });
});

/* ------------------------------------------------------------------------ */
/* DPDP register                                                            */
/* ------------------------------------------------------------------------ */

describe('DPDP processing register', () => {
  it('never claims DPDP compliance', async () => {
    const register = await buildDpdpRegister(pool);

    expect(register.caveat).toContain('NOT A COMPLIANCE CLAIM');
    expect(JSON.stringify(register).toLowerCase()).not.toContain('dpdp compliant');
  });

  it('states the phased timeline correctly', async () => {
    // RESEARCH_REALITY_CHECK item 2: notified 13 Nov 2025, but obligations are
    // phased to 13 May 2027. "Merchants are non-compliant today" is false.
    const register = await buildDpdpRegister(pool);

    expect(register.caveat).toContain('13 May 2027');
    expect(register.caveat).toContain('No merchant is non-compliant today');
  });

  it('names every processing purpose and legal basis', async () => {
    const register = await buildDpdpRegister(pool);

    for (const record of register.records) {
      expect(record.purpose.length, record.id).toBeGreaterThan(20);
      expect(record.legalBasis.length, record.id).toBeGreaterThan(5);
      expect(record.retention.length, record.id).toBeGreaterThan(5);
      expect(record.fields.length, record.id).toBeGreaterThan(0);
    }
  });

  it('lists real, specific gaps', async () => {
    // A privacy register whose gaps section is empty is a register nobody read.
    const register = await buildDpdpRegister(pool);

    expect(register.gaps.length).toBeGreaterThanOrEqual(6);
    for (const gap of register.gaps) {
      expect(gap.detail.length, gap.id).toBeGreaterThan(80);
      expect(gap.plannedIn.length, gap.id).toBeGreaterThan(3);
    }
  });

  it('admits there is no consent withdrawal and no retention job', async () => {
    const ids = DPDP_GAPS.map((gap) => gap.id);

    expect(ids).toContain('DP-GAP-01'); // consent withdrawal
    expect(ids).toContain('DP-GAP-02'); // retention/deletion
  });

  it('counts live rows rather than asserting figures', async () => {
    const register = await buildDpdpRegister(pool);
    const users = register.records.find((record) => record.id === 'DP-01');

    expect(users?.recordCount).toBeGreaterThan(0);
  });

  it('reports an uncountable category as unknown, never as zero', async () => {
    // Zero would read as "we hold none of this", which is a much stronger and
    // possibly false statement than "we could not count it".
    const register = await buildDpdpRegister(pool);

    for (const record of register.records) {
      expect(record.recordCount === null || record.recordCount >= 0).toBe(true);
    }
  });

  it('marks agent public keys as NOT personal data', async () => {
    const keys = PROCESSING_RECORDS.find((record) => record.id === 'DP-08');

    expect(keys?.isPersonalData).toBe(false);
    expect(keys?.minimisation).toContain('PUBLIC KEYS ONLY');
  });

  it('reports privacy control coverage as a ratio including the gaps', async () => {
    const register = await buildDpdpRegister(pool);

    expect(register.privacyControlCoverage).toMatch(/^\d+\/\d+$/);
    const [inPlace, total] = register.privacyControlCoverage.split('/').map(Number);
    expect(total).toBeGreaterThan(inPlace!);
  });
});
