import { apiGet, formatDateTime, formatPaise } from '@/lib/api';
import type { MandateRow } from '@/lib/types';
import { ApiFailure, Card, Empty, Status } from '@/components/ui';

export const dynamic = 'force-dynamic';

/**
 * Mandates.
 *
 * The question this screen answers is "what is this agent actually allowed to
 * spend?" — so the LIMITS are the content, not metadata about the row. Spend to
 * date sits next to the window limit, because the only useful reading of either
 * is against the other.
 */
export default async function MandatesPage() {
  let mandates: MandateRow[];
  try {
    mandates = (await apiGet<{ mandates: MandateRow[] }>(
      '/v1/console/mandates?limit=100',
    )).mandates;
  } catch (error) {
    return <ApiFailure error={error} />;
  }

  return (
    <>
      <header className="page-header">
        <h1 className="page-title">Mandates</h1>
        <p className="page-sub">
          The authority a user has granted an agent. Terms are immutable and
          versioned — a decision made under version 1 stays explainable against
          version 1 after version 3 raises the limit.
        </p>
      </header>

      <Card hint={`${mandates.length} shown`}>
        {mandates.length === 0 ? (
          <Empty
            title="No mandates"
            hint={<>Run <code>npm run seed -w apps/api</code> to load fixtures.</>}
          />
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Status</th><th>Mandate</th><th>Agent</th>
                  <th className="num">Per txn</th><th className="num">Per window</th>
                  <th className="num">Spent</th>
                  <th>Merchants</th><th>Window</th><th className="num">Valid to</th>
                </tr>
              </thead>
              <tbody>
                {mandates.map((mandate) => (
                  <tr key={mandate.id}>
                    <td><Status value={mandate.status} /></td>
                    <td>
                      <div className="mono nowrap">{mandate.id}</div>
                      <div className="faint" style={{ fontSize: 12 }}>
                        {mandate.label} · v{mandate.version}
                      </div>
                    </td>
                    <td className="mono nowrap faint">{mandate.agentId}</td>
                    <td className="num">{formatPaise(mandate.perTxnLimitPaise)}</td>
                    <td className="num">
                      {formatPaise(mandate.windowLimitPaise)}
                      <div className="faint" style={{ fontSize: 11 }}>per {mandate.windowKind}</div>
                    </td>
                    <td className="num">{formatPaise(mandate.capturedPaise)}</td>
                    <td className="mono faint" style={{ fontSize: 11, maxWidth: 200 }}>
                      {mandate.merchantIds.length === 0
                        ? <span className="pill pill-block">none — deny all</span>
                        : mandate.merchantIds.join(', ')}
                    </td>
                    <td className="faint nowrap" style={{ fontSize: 12 }}>
                      {String(mandate.windowStartHour).padStart(2, '0')}:00–
                      {String(mandate.windowEndHour).padStart(2, '0')}:00
                      <div>{mandate.timezone}</div>
                    </td>
                    <td className="num faint nowrap">{formatDateTime(mandate.validTo)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      <div className="caveat">
        <strong>An empty merchant list means NO merchant is permitted</strong>,
        not “all”. Deny by default: the difference between an empty allowlist and
        a missing one is the difference between a locked door and no door.
      </div>
    </>
  );
}
