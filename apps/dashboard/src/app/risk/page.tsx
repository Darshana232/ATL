import Link from 'next/link';
import { apiGet, formatDateTime, formatPaise } from '@/lib/api';
import type { RiskRow } from '@/lib/types';
import { ApiFailure, Banner, Card, Empty } from '@/components/ui';

export const dynamic = 'force-dynamic';

/**
 * Risk signals.
 *
 * The most important thing on this screen is the WARNING at the top, not the
 * table. A risk score looks authoritative; this one is a labelled simulation
 * with invented heuristics, and it cannot change any verdict. Presenting it
 * without that framing would be the single most misleading thing this console
 * could do.
 */
export default async function RiskPage() {
  let signals: RiskRow[];
  let note = '';

  try {
    const body = await apiGet<{ signals: RiskRow[]; note: string }>('/v1/console/risk?limit=100');
    signals = body.signals;
    note = body.note;
  } catch (error) {
    return <ApiFailure error={error} />;
  }

  return (
    <>
      <header className="page-header">
        <h1 className="page-title">Risk signals</h1>
        <p className="page-sub">
          Advisory scoring alongside each authorization. It may raise a FLAG; it
          can never override a BLOCK or create a PASS.
        </p>
      </header>

      <div className="stack">
        <Banner kind="warn" title="This is a SIMULATION, and it is not fraud detection">
          {note}
          {' '}Authorization (“was this permitted?”) and fraud detection (“was
          this suspicious?”) are different problems with different correctness
          criteria. Merging them would make our verdicts unexplainable and our
          fraud detection untestable.
        </Banner>

        <Card hint={`${signals.length} shown, highest score first`}>
          {signals.length === 0 ? (
            <Empty title="No risk signals" hint="No authorizations have been scored yet." />
          ) : (
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th className="num">Score</th><th>Band</th><th>Provider</th>
                    <th>Agent</th><th className="num">Amount</th>
                    <th>Verdict</th><th>Factors</th>
                    <th className="num">Latency</th><th className="num">When</th>
                  </tr>
                </thead>
                <tbody>
                  {signals.map((signal) => (
                    <tr key={signal.id}>
                      <td className="num"><strong>{signal.score}</strong></td>
                      <td>
                        <span className={`pill ${
                          signal.band === 'HIGH' ? 'pill-block'
                          : signal.band === 'MEDIUM' ? 'pill-flag' : 'pill-pass'}`}
                        >
                          {signal.band}
                        </span>
                      </td>
                      <td className="mono faint">{signal.provider}</td>
                      <td className="mono nowrap faint">{signal.agentId}</td>
                      <td className="num">{formatPaise(signal.amountPaise)}</td>
                      <td className="mono faint">
                        {signal.decisionId === null ? '—' : (
                          <Link href={`/decisions/${signal.decisionId}`}>{signal.verdict}</Link>
                        )}
                      </td>
                      <td className="muted" style={{ maxWidth: 340, fontSize: 12 }}>
                        {signal.reasons.join('; ')}
                      </td>
                      <td className="num faint">
                        {signal.latencyMs === null ? '—' : `${signal.latencyMs}ms`}
                      </td>
                      <td className="num faint nowrap">{formatDateTime(signal.createdAt)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>
      </div>
    </>
  );
}
