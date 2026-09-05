import Link from 'next/link';
import { apiGet, formatDateTime, formatPaise } from '@/lib/api';
import type { DecisionSummary } from '@/lib/types';
import { ApiFailure, Card, Empty, SimulationBadge, Verdict } from '@/components/ui';

export const dynamic = 'force-dynamic';

/**
 * Decisions.
 *
 * WHO USES THIS: a compliance officer answering "why was this refused?", and a
 * support engineer answering "why did my agent's payment fail?".
 *
 * Both need the REASON visible in the list, not behind a click. The reason
 * contains the numbers, and the numbers are the answer.
 */
export default async function DecisionsPage(
  { searchParams }: { searchParams: Promise<{ verdict?: string }> },
) {
  const params = await searchParams;
  const verdict = params.verdict;

  let decisions: DecisionSummary[];
  try {
    const query = verdict === undefined ? '' : `&verdict=${encodeURIComponent(verdict)}`;
    decisions = (await apiGet<{ decisions: DecisionSummary[] }>(
      `/v1/console/decisions?limit=100${query}`,
    )).decisions;
  } catch (error) {
    return <ApiFailure error={error} />;
  }

  const filters = [
    { label: 'All', value: undefined },
    { label: 'Blocked', value: 'BLOCK' },
    { label: 'Flagged', value: 'FLAG' },
    { label: 'Passed', value: 'PASS' },
  ];

  return (
    <>
      <header className="page-header">
        <h1 className="page-title">Decisions</h1>
        <p className="page-sub">
          Every authorization request and the deterministic verdict it received.
          Each decision carries the full per-rule breakdown — including the
          checks that passed.
        </p>
      </header>

      <div className="row" style={{ marginBottom: 14 }}>
        {filters.map((filter) => (
          <Link
            key={filter.label}
            href={filter.value === undefined ? '/decisions' : `/decisions?verdict=${filter.value}`}
            className="btn"
            style={verdict === filter.value
              ? { background: 'var(--accent-bg)', borderColor: 'var(--accent)', color: 'var(--accent)' }
              : undefined}
          >
            {filter.label}
          </Link>
        ))}
      </div>

      <Card hint={`${decisions.length} shown`}>
        {decisions.length === 0 ? (
          <Empty
            title="No decisions match this filter"
            hint={
              verdict === undefined
                ? <>Run <code>npm run demo:agent -w apps/api</code> to generate activity.</>
                : <>No decisions with verdict {verdict}. Try “All”.</>
            }
          />
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Verdict</th>
                  <th>Decision</th>
                  <th>Agent</th>
                  <th>Merchant</th>
                  <th className="num">Amount</th>
                  <th>Reason</th>
                  <th>Risk</th>
                  <th>Payment</th>
                  <th className="num">Evaluated</th>
                </tr>
              </thead>
              <tbody>
                {decisions.map((decision) => (
                  <tr key={decision.id}>
                    <td><Verdict value={decision.verdict} /></td>
                    <td className="mono nowrap">
                      <Link href={`/decisions/${decision.id}`}>
                        {decision.id.slice(0, 14)}…
                      </Link>
                    </td>
                    <td className="mono nowrap">{decision.agentId}</td>
                    <td className="mono nowrap">{decision.merchantId}</td>
                    <td className="num">{formatPaise(decision.amountPaise)}</td>
                    <td className="muted" style={{ minWidth: 300, maxWidth: 460 }}>
                      {decision.reason}
                    </td>
                    <td className="num faint">
                      {decision.riskScore === null ? '—' : decision.riskScore}
                    </td>
                    <td>
                      {decision.payment === null
                        ? <span className="faint">—</span>
                        : <SimulationBadge simulated={decision.payment.simulated} />}
                    </td>
                    <td className="num faint nowrap">{formatDateTime(decision.evaluatedAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </>
  );
}
