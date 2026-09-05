import { apiGet, formatDateTime } from '@/lib/api';
import type { CoverageReport } from '@/lib/types';
import { ApiFailure, Banner, Card, Metric } from '@/components/ui';

export const dynamic = 'force-dynamic';

/**
 * FREE-AI control coverage.
 *
 * THE MOST DANGEROUS SCREEN IN THE CONSOLE, because it is the one somebody will
 * screenshot and put in a pitch deck.
 *
 * So the headline is a RATIO ("20/26"), never a percentage. A ratio invites the
 * question "which six?" — exactly the question a compliance officer should ask.
 * A percentage invites nothing, and implies a denominator somebody else agreed
 * to. There is no such denominator: FREE-AI is a committee framework with no
 * certifying authority and no scoring methodology.
 *
 * The gaps are rendered FIRST, above the covered controls, and they are not
 * collapsible.
 */
export default async function FreeAiPage() {
  let report: CoverageReport;
  try {
    report = await apiGet<CoverageReport>('/v1/reports/free-ai');
  } catch (error) {
    return <ApiFailure error={error} />;
  }

  const gaps = report.controls.filter((control) => control.status !== 'covered');
  const covered = report.controls.filter((control) => control.status === 'covered');

  return (
    <>
      <header className="page-header">
        <h1 className="page-title">FREE-AI control coverage</h1>
        <p className="page-sub">
          Our own controls mapped to the RBI FREE-AI committee framework, with
          evidence queried live from the database. Generated{' '}
          {formatDateTime(report.generatedAt)}.
        </p>
      </header>

      <div className="stack">
        <div className="metrics">
          <Metric
            label="Control coverage"
            value={report.coverage}
            note="controls with evidence, over controls in scope"
          />
          <Metric
            label="Not implemented"
            value={report.notImplemented}
            note="named below, with the reason"
          />
          <Metric
            label="Evidence"
            value="live"
            note="every figure is a database query, none hand-maintained"
          />
        </div>

        <Banner kind="warn" title="This is not a compliance score">
          There is no certifying authority for FREE-AI, no audit scheme and no
          scoring methodology — so a percentage would be unmeasurable. This is a
          count of our controls that have evidence right now.
        </Banner>

        {/* Gaps first. Always. */}
        <Card title={`Gaps — ${gaps.length} controls without evidence`}>
          <div className="card-body stack">
            {gaps.map((control) => (
              <div key={control.id} className="control-row">
                <div>
                  <div className="control-title">
                    <span className="mono faint">{control.id}</span> {control.title}
                  </div>
                  <div className="control-desc">{control.description}</div>
                  {control.gap !== null && <div className="control-gap">{control.gap}</div>}
                </div>
                <span className="pill pill-block">{control.status}</span>
              </div>
            ))}
          </div>
        </Card>

        <Card title={`Covered — ${covered.length} controls with evidence`}>
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Control</th><th>Sutra</th><th>Pillar</th>
                  <th className="num">Evidence</th><th>Measured by</th>
                </tr>
              </thead>
              <tbody>
                {covered.map((control) => (
                  <tr key={control.id}>
                    <td style={{ maxWidth: 420 }}>
                      <div className="control-title">
                        <span className="mono faint">{control.id}</span> {control.title}
                      </div>
                      <div className="control-desc">{control.description}</div>
                      {control.limitation !== null && (
                        <div className="control-limit">
                          <strong>Limitation:</strong> {control.limitation}
                        </div>
                      )}
                    </td>
                    <td className="faint" style={{ fontSize: 12 }}>{control.sutra}</td>
                    <td className="faint" style={{ fontSize: 12 }}>{control.pillar}</td>
                    <td className="num"><strong>{control.evidenceCount.toLocaleString('en-IN')}</strong></td>
                    <td className="faint" style={{ fontSize: 12, maxWidth: 260 }}>
                      {control.evidenceLabel}
                      {control.evidenceSample !== null && (
                        <div className="mono" style={{ fontSize: 11 }}>{control.evidenceSample}</div>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>

        <Card title="Coverage by pillar">
          <div className="card-body">
            <div className="metrics">
              {report.byPillar.map((row) => (
                <Metric key={row.pillar} label={row.pillar} value={`${row.covered}/${row.total}`} />
              ))}
            </div>
          </div>
        </Card>

        <div className="caveat">
          <strong>Read this before quoting the number.</strong> {report.caveat}
        </div>
      </div>
    </>
  );
}
