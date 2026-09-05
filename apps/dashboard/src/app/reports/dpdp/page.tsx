import { apiGet, formatDateTime } from '@/lib/api';
import type { DpdpRegister } from '@/lib/types';
import { ApiFailure, Banner, Card, Metric } from '@/components/ui';

export const dynamic = 'force-dynamic';

/**
 * DPDP processing register.
 *
 * Same shape as the FREE-AI screen and for the same reason: gaps first, ratio
 * not percentage, caveat unsuppressed.
 *
 * The specific thing this screen must never say is "DPDP compliant". Nobody is
 * required to be yet — the obligations are phased to 13 May 2027 — so the claim
 * would be both false and unnecessary.
 */
export default async function DpdpPage() {
  let register: DpdpRegister;
  try {
    register = await apiGet<DpdpRegister>('/v1/reports/dpdp');
  } catch (error) {
    return <ApiFailure error={error} />;
  }

  return (
    <>
      <header className="page-header">
        <h1 className="page-title">DPDP data-processing register</h1>
        <p className="page-sub">
          What personal data this system holds, why, for how long, and what
          protects it — with the gaps named. Generated{' '}
          {formatDateTime(register.generatedAt)}.
        </p>
      </header>

      <div className="stack">
        <div className="metrics">
          <Metric
            label="Privacy control coverage"
            value={register.privacyControlCoverage}
            note="controls in place, over controls plus known gaps"
          />
          <Metric
            label="Personal data categories"
            value={register.personalDataCategories}
            note={`of ${register.records.length} processing records`}
          />
          <Metric label="Known gaps" value={register.gaps.length} note="listed below, unsoftened" />
        </div>

        <Banner kind="warn" title="This is not a claim of DPDP compliance">
          The DPDP Rules 2025 are phased: the Data Protection Board took effect on
          notification, Consent Manager registration and penalties land 13 Nov
          2026, and full notice, consent, security and rights obligations land
          <strong> 13 May 2027</strong>. No merchant is non-compliant today for
          lacking these controls.
        </Banner>

        <Card title={`Gaps — ${register.gaps.length}`}>
          <div className="card-body stack">
            {register.gaps.map((gap) => (
              <div key={gap.id} className="control-row">
                <div>
                  <div className="control-title">
                    <span className="mono faint">{gap.id}</span> {gap.title}
                  </div>
                  <div className="control-gap">{gap.detail}</div>
                </div>
                <span className="pill pill-skip">{gap.plannedIn}</span>
              </div>
            ))}
          </div>
        </Card>

        <Card title="Processing records">
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Category</th><th>Fields</th><th>Purpose &amp; basis</th>
                  <th>Minimisation</th><th>Retention</th><th className="num">Rows</th>
                </tr>
              </thead>
              <tbody>
                {register.records.map((record) => (
                  <tr key={record.id}>
                    <td style={{ minWidth: 150 }}>
                      <div className="control-title">{record.dataCategory}</div>
                      <div className="faint" style={{ fontSize: 11 }}>
                        {record.id} ·{' '}
                        {record.isPersonalData
                          ? <span className="pill pill-flag">personal data</span>
                          : <span className="pill pill-skip">not personal</span>}
                      </div>
                    </td>
                    <td className="mono faint" style={{ fontSize: 11, maxWidth: 170 }}>
                      {record.fields.join(', ')}
                    </td>
                    <td className="muted" style={{ fontSize: 12, maxWidth: 280 }}>
                      {record.purpose}
                      <div className="faint" style={{ marginTop: 3 }}>
                        <strong>Basis:</strong> {record.legalBasis}
                      </div>
                    </td>
                    <td className="muted" style={{ fontSize: 12, maxWidth: 320 }}>
                      {record.minimisation}
                    </td>
                    <td className="faint" style={{ fontSize: 12, maxWidth: 180 }}>
                      {record.retention}
                    </td>
                    <td className="num">
                      {record.recordCount === null
                        ? <span className="faint" title="Could not be counted — NOT zero">unknown</span>
                        : record.recordCount.toLocaleString('en-IN')}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>

        <div className="caveat">
          <strong>Data never collected cannot leak.</strong> The strongest control
          in this register is architectural, not procedural: there is physically
          nowhere in the schema to put a full phone number or an unmasked VPA.
          Encryption, access control and redaction reduce risk; minimisation
          eliminates it.
          <br /><br />
          {register.caveat}
        </div>
      </div>
    </>
  );
}
